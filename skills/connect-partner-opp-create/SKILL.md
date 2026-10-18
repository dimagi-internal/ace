---
name: connect-partner-opp-create
description: >
  Give a partner org its own opportunity on an existing program. Needs the program and org.
---

# Create a partner opportunity on an existing program

Gives a partner organisation (an awarded LLO, or any org joining a live program) its own delivery
opportunity on a program that already exists. It covers the round trip and the build of the
partner's opportunity:

1. invite the org to the program;
2. accept its application;
3. copy, build and release fresh apps;
4. create the opportunity held by the partner;
5. add its payment units.

It does not email the partner; `llo-onboarding` sends the onboarding email after this skill
returns.

Platform facts: [`connect-api.md` § Changing a live opportunity](../../playbook/integrations/connect-api.md#changing-a-live-opportunity)
and § Data model gotchas. This skill is the procedure; `llo-onboarding` Step 2 calls it.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the program UUID | explicit arg; default: `opp.yaml.connect.program.id`; else the program context doc's Scope |
| `program_org` | the PM-side org running the program, whose URL serves the invite, accept and create | explicit arg; default: the org in the program's recorded URL (`opp.yaml.connect.program.url`, `/a/<org>/program/<id>/`); inside a run, `connect_orgs.pm_org` from preflight. Never typed. |
| `partner_org_slug` | the org that will hold the opportunity | explicit arg; default: run_state `phases.solicitation-management.products.selected_llo.org_slug`. A slug from the org's Connect URL, never derived from its display name (see `llo-onboarding` § How the LLO got there) |
| `program_application_id` | an application that already exists, to skip the invite | explicit arg; default: run_state `selected_llo.program_application_id` |
| `source_apps` | `{hq_domain, learn_app_id, deliver_app_id}`: the released HQ apps to copy | explicit arg; default: run_state `phases.commcare-setup.products.apps`; else the context doc's Scope |
| `opportunity` | `name`, `short_description` (50 chars max), `description`, `start_date`, `end_date`, `total_budget`, `is_test` | explicit arg; default: the PDD's § Program Parameters, with the **work order's** settled rate and budget |
| `payment_units` | the units to create: amounts, caps, the deliver units each requires | explicit arg; default: the work order's settled rate, in the program's currency |
| `verification_flags` | the Layer A criteria the Evidence Model names | explicit arg; default: the PDD Evidence Model, per `connect-opp-setup` Step 5 |

No `run_state.yaml` is needed when every parameter is passed.

## Products

The result, returned to the caller and recorded where one is bound:

- `program_application_id`, `opportunity_id`, `opportunity_url`, the fresh `learn_app_id` /
  `deliver_app_id` and their build ids, and the payment-unit ids.
- Inside a run, the caller (`llo-onboarding` Step 7) writes these into `selected_llo`.
- On a program project, a dated line in the context doc's Decisions, plus the new ids in its Scope.

## What this skill cannot do

| Requested | Why not | Say instead |
|---|---|---|
| Reuse the build/QA opportunity's apps | A deliver unit backs exactly one payment unit, ever, within a holding org (ace#573), so the second opportunity cannot create its payment units | Fresh app copies (Step 3), which is what this skill does |
| Accept an application for a real partner still at `INVITED` | That would enrol them without their consent, and it cannot be undone (ace#2954, the tekzal/20261013-2314 incident). `connect_accept_program_application` refuses it with `PartnerHasNotAppliedError` | Ask the partner to accept the invitation in Connect, then retry |
| Move the opportunity to another org later | `target_organization_slug` is create-time only; `connect_update_opportunity` has no org field (ace#2919) | Get `partner_org_slug` right before Step 4 |
| Start the opportunity before the program, or end it after | Connect refuses any opportunity outside its program's window | Halt and ask; never clamp a contractual date |

## Process

1. **Confirm the approval.** This creates objects on a live program and, for a real partner,
   sends them a Connect invitation. The caller at level 0 must already have shown the plan and got
   approval: `/ace:run`'s Phase 9 gate, or `partner-on-connect-program § Changing a live program`.
   A subagent cannot ask the human, so with no recorded approval, return the plan and stop.
2. **Invite, then accept.**
   1. If no `program_application_id` was passed, call `connect_send_llo_invite`
      (`organization_slug: program_org`, `program_id`, `organization: partner_org_slug`).
      **Capture `program_application_id` from this response, now.** `connect_list_invites` shows
      the PM page's rows (org name and status) and only an integer row id, never the UUID, so it
      cannot be recovered later.
   2. Read `connect_list_invites`.
      - **`ACCEPTED`:** go on.
      - **`APPLIED`:** accept with `connect_accept_program_application`.
      - **`INVITED` and the partner is ACE-controlled** (an internal-testing fixture, such as
        `connect_orgs.llo_org`): accept with `connect_accept_program_application`; ACE has no
        apply step.
      - **`INVITED` and a real partner:** stop and say the partner must accept the invitation
        in Connect.
3. **Copy, build and release fresh apps.**
   - Copy each source app with `commcare_linked_app_copy`, using **the same domain for upstream
     and downstream** and `linked: false`. That is HQ's generic Copy Application. A copy keeps
     `acquire`/`grid` (so it avoids ace#1643) and destroys nothing.
   - Then build and release each copy: `commcare_make_build`, then `commcare_release_build`.
   - Two traps:
     - **The copy's `name` must be unique.** Id recovery is by name.
     - **A 30s timeout on the recovery re-list does not mean the copy failed.** Re-list with
       `commcare_list_apps` before retrying, or you make a duplicate.
4. **Create the opportunity** with `connect_create_opportunity`:
   - `organization_slug: program_org` and `target_organization_slug: partner_org_slug`;
   - the fresh app ids from step 3;
   - the `opportunity` parameters. The name rule for `is_test: true` (the run-id prefix) and the
     50-char `short_description` cap are code-enforced by the atom (`docs/atom-schemas.md`).

   **Treat *"Organization must have an accepted application for this program"* as Connect's
   acceptance verdict.** If it comes back, step 2 did not reach `ACCEPTED`; go back to it, and
   never work around it. If `start_date` / `end_date` fall outside the program window
   (`connect_get_program`), **halt and ask**.
5. **Add the payment units** with `connect_create_payment_units`, following
   `connect-opp-setup` Step 6 (§ Operations on an existing opportunity). That means:
   - whole-currency integers, never cents;
   - a non-empty `required_deliver_units` of `server_id`s read from `connect_list_deliver_units`
     on the new opportunity;
   - `total_budget` passed, so the server enforces funds for at least one worker (ace#729).
6. **Set the verification flags** the Evidence Model names, per `connect-opp-setup` Step 5, then
   **activate** with `connect_activate_opportunity`. Activation needs a payment unit to exist
   (ace#584), which is why it comes last.
7. **Read back.** Read each object fresh and compare it with what was requested:
   - `connect_get_opportunity` (holding org, dates, budget, app ids, active);
   - `connect_list_payment_units`;
   - `connect_get_verification_flags`.

   Any mismatch is a failed create: report it, and do not hand a half-built opportunity to the
   onboarding email.
8. **Return** the § Products ids to the caller, and record them where one is bound.

## MCP Tools Used

- ace-connect: `connect_send_llo_invite`, `connect_list_invites`, `connect_accept_program_application`, `connect_get_program`, `connect_create_opportunity`, `connect_list_deliver_units`, `connect_create_payment_units`, `connect_set_verification_flags`, `connect_get_verification_flags`, `connect_activate_opportunity`, `connect_get_opportunity`, `connect_list_payment_units`, `commcare_linked_app_copy`, `commcare_list_apps`, `commcare_make_build`, `commcare_release_build`

## Existing objects

- **Deliver units are shared within a holding org on the same released Deliver app** (ace#573).
  This is the whole reason Step 3 copies the apps: the partner's opportunity needs its own
  `cc_app_id`s, so it gets fresh deliver units its payment units can bind. Two opportunities (the
  build/QA one and the partner's) is the correct model, not a workaround.
- **The Learn `passing_score` lives on the shared `CommCareApp` row** (ace#1350). The fresh Learn
  copy gets its own row, so the partner's pass mark is independent of the build/QA opportunity's.
  Reuse a Learn app and the score posted at create is silently discarded.
- **The holding org is create-time only** (ace#2919). `partner_org_slug` is checked against the
  invite in step 2 before the create.
- **An application UUID is visible only in the invite response.** Step 2 captures it at once.
- **Connect has no opportunity-delete API.** A duplicate create strands the first opportunity
  for good (ace#2083), so `connect_create_opportunity`'s exact-name refusal is never overridden
  without an operator decision.

## Mode Behavior

- **Auto:** with approval recorded in the dispatch, runs steps 2–8 and halts on the first refusal
  or read-back mismatch.
- **Review:** presents the plan (org, apps to copy, opportunity parameters, payment units) and
  waits.

## Dry-Run Behavior

When `--dry-run` is active, read `connect_get_program`, `connect_list_invites` and the source apps,
and write the plan. Make no writes.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version, extracted from `llo-onboarding` Step 2/2a/2b so a partner opportunity can be added to any existing program with explicit ids (#3148 batch 4) | ACE |
