# V1 Dry-Run Report — 2026-05-22

End-to-end exercise of `/ace:interview-domain-bootstrap` + `/ace:interview-cohort-create` against ACE-owned infrastructure. Verifier deferred until blockers cleared.

**Inputs used:**
- `domain.yaml` — master `ace-interviews-master`, downstream `ace-interviews-test`, program `f65e0633-cdb2-4d93-875a-b237ed241b18`
- `cohort-08TRS.yaml` — cohort `08TRS`, schedule te001 → te002 → te003

## Results

### ✅ Successful — fully exercised

| # | Step | Atom | Output |
|---|---|---|---|
| 1 | HQ master domain | `commcare_create_domain` | `ace-interviews-master` exists |
| 2 | HQ downstream | `commcare_create_domain` | `ace-interviews-test` exists |
| 3 | Linked-domain pair | `commcare_link_domains` | master → test (`has_full_access: false` — see open question below) |
| 4 | Connect program | `connect_create_program` | `f65e0633-cdb2-4d93-875a-b237ed241b18` (existing) |
| 5 | OCS stub template bot | `ocs_create_chatbot` | experiment 12213 (existing) |
| 6 | Master UCR: `Register User OCS` | `commcare_create_ucr_expression` | id 294 |
| 7 | Master UCR: `Trigger OCS Bot` | `commcare_create_ucr_expression` | id 295 |
| 8 | Master UCR: `Session Completion API` | `commcare_create_ucr_expression` | id 296 |
| 9 | Master UCR: `24 hr Expiry API` | `commcare_create_ucr_expression` | id 297 |
| 10 | Master interview_schedule | `commcare_create_lookup_table` | id `aae6325f679745…` |
| 11 | Test UCR: `Register User OCS` | `commcare_create_ucr_expression` | id 298 |
| 12 | Test UCR: `Trigger OCS Bot` | `commcare_create_ucr_expression` | id 299 |
| 13 | Test UCR: `Session Completion API` | `commcare_create_ucr_expression` | id 300 |
| 14 | Test UCR: `24 hr Expiry API` | `commcare_create_ucr_expression` | id 301 |
| 15 | Test interview_schedule | `commcare_create_lookup_table` | id `c14dc409c46649…` |
| 16 | Test connection `Connect Interviews` | `commcare_create_connection` | id 10020 |
| 17 | Test connection `OCS Interviews Bot` | `commcare_create_connection` | id 10021 |
| 18 | Test FormRepeater `Connect Interviews` | `commcare_create_repeater` | created (no id returned) |
| 19 | Per-domain OCS bot | `ocs_create_chatbot` | experiment 12219, pipeline 5987 |
| 20 | OCS bot router splice | `ocs_add_pipeline_node` | `StaticRouterNode-c31d6` inserted between Start and LLM |
| 21 | OCS bot 24hr timeout event | `ocs_add_chatbot_event` | attached |
| 22 | OCS bot session-completion action | `ocs_add_custom_action` | id 36 |
| 23 | OCS bot 24hr-expiry action | `ocs_add_custom_action` | id 37 |
| 24 | Wire session-completion action to LLM | `ocs_link_action_to_node` | linked to `LLMResponseWithPrompt-cf03e` |
| 25 | Cohort 08TRS lookup_table rows | `commcare_lookup_table_append_rows` | 3 rows appended (te001/te002/te003 schedule) |

### ❌ Failed — blocked on identified causes

| # | Step | Atom | Cause |
|---|---|---|---|
| F1 | Test Configurable Form Repeater `OCS User Registration` | `commcare_create_repeater` (FormExpressionRepeater) | **500** — `expression_repeater` feature flag not enabled on `ace-interviews-test` |
| F2 | Test Inbound API `Session Completion API` | `commcare_create_inbound_api` | **404** — `configurable_api` feature flag not enabled on `ace-interviews-test` |
| F3 | Test custom user data field `cohort_id` | `commcare_set_user_fields` (and list_user_fields preflight) | **302 redirect** — `ace@dimagi-ai.com` lacks `can_edit_commcare_users` permission on `ace-interviews-test`. Same on master likely. |
| F4 | Cohort 08TRS Connect opportunity | `connect_create_opportunity` | **Schema blocker** — `target_organization_slug` required (must be an LLO with accepted program application). No LLO set up for ACE-owned dry-run. Also `learn_app.cc_app_id` + `deliver_app.cc_app_id` required (no linked apps exist on test yet — that's the manual linked-app-copy step). |
| F5 | Cohort 08TRS payment unit + activation | downstream Connect atoms | Cascaded from F4 — no opp_id to attach. |
| F6 | Cohort 08TRS payment conditional alert | (no atom) | Atom not built — 3-form combined POST blocker per earlier investigation. |
| F7 | OCS router-node keywords add (te001/te002/te003) | (no atom) | `ocs_update_pipeline_node` not built; gap-tagged. |

## Blocker summary — exact unblocking actions

### 1. HQ feature flags (need superadmin) — blocks F1 + F2

Already emailed Ali/Andrea (msg `19e4f1566e57b113`). When their reply confirms the list, the toggles below need to be enabled on both `ace-interviews-master` and `ace-interviews-test`:
- `expression_repeater` (EXPRESSION_REPEATER) — unblocks F1
- `configurable_api` (GENERIC_INBOUND_API) — unblocks F2
- `commcare_connect` (COMMCARE_CONNECT) — needed for Connect integration in apps
- (`expression_registry` is already enabled — UCR creation worked)

URL: `/hq/admin/toggle_edit/<slug>/` on each domain.

### 2. HQ web-user permission (need domain admin) — blocks F3

`ace@dimagi-ai.com` needs `can_edit_commcare_users` permission on both new domains. Currently the user appears to lack the "Edit Mobile Workers" role permission. Fix: at `/a/ace-interviews-master/users/web/` and `/a/ace-interviews-test/users/web/`, grant `ace@dimagi-ai.com` the Admin role (or a custom role with Edit Mobile Workers).

### 3. LLO org setup for Connect opp — blocks F4 + F5

For the ACE-owned dry-run, two paths:
- **(a)** Use `ai-demo-space` itself as the target LLO (same as PM org). Requires sending an LLO invite from the program to `ai-demo-space` and accepting it back. Doable via existing `connect_send_llo_invite` + `connect_accept_program_application` atoms.
- **(b)** Stand up a separate "ACE Test LLO" org in Connect (manual). Cleaner but requires admin work.

Recommend (a) for V1 acceptance — minimum new infrastructure.

### 4. Linked-app copy atom — blocks F4

No `commcare_linked_app_copy` atom yet (gap-tagged in schema). Manual linked-app pull via HQ admin UI is the current path. For full E2E test we need either to build the atom or do this step manually once.

### 5. Conditional alert atom — blocks F6

Documented blocker. Atom create requires modeling against a reference alert (the team's existing ones). Their reply to the FF question will likely surface the reference alerts they're using.

### 6. OCS router-keywords update atom — blocks F7

The per-cohort step that adds the cohort's `te001/te002/te003` interview_ids to the StaticRouterNode's `keywords` array. The atom does GET-mutate-POST on the pipeline; can be built by extending `addPipelineNode` to support node updates. ~1 hour of work.

## State of the world after this dry run

**On HQ:**
- `ace-interviews-master`: 4 UCRs (294-297), interview_schedule (no cohort rows)
- `ace-interviews-test`: 4 UCRs (298-301), interview_schedule (3 rows for cohort 08TRS), 2 connections (10020, 10021), 1 FormRepeater "Connect Interviews"

**On OCS team `connect-ace`:**
- experiment 12213 — original stub template
- experiment 12219 (pipeline 5987) — per-domain bot for ace-interviews-test
  - Pipeline: Start → StaticRouterNode-c31d6 → LLMResponseWithPrompt-cf03e (linked to action 36) → End
  - 24hr inactivity timeout event attached
  - Custom action 36 (Session Completion) — wired to LLM
  - Custom action 37 (24hr Expiry) — not yet wired (would need secondary pipeline per arch finding)

**On Connect (`ai-demo-space`):**
- Program `ace-interviews-test` (`f65e0633-…`) — no opportunities yet

## Open question on link_domains

The `commcare_link_domains` call returned `has_full_access: false` in its response. Worth investigating whether this affects linked-domain content sync (UCRs / apps / lookup tables push from master to downstream). May indicate that ace@ needs additional permission on one of the domains for full sync.

## Atoms that just got their first live exercise (and worked)

These were built earlier but unexercised on the V1 path until now:
- `commcare_create_ucr_expression` ×8 (4 master + 4 test, all clean)
- `commcare_create_connection` ×2 (Connect Interviews + OCS Interviews Bot)
- `commcare_create_repeater` (FormRepeater variant, with `format='form_json'`)
- `commcare_lookup_table_append_rows` (3 rows in one call)
- `ocs_create_chatbot` (second bot in the team)
- `ocs_add_pipeline_node` (splice into a fresh pipeline)
- `ocs_add_chatbot_event` (24hr timeout)
- `ocs_add_custom_action` ×2
- `ocs_link_action_to_node`

## Next session checklist

When the human blockers clear (FFs + permission + LLO), rerun the failed steps:

1. ☐ Toggle 3 feature flags on both domains (need HQ superadmin, link sent to team)
2. ☐ Grant `ace@dimagi-ai.com` Admin role on both ace-interviews-* domains
3. ☐ Decide: LLO = `ai-demo-space` (send+accept self-invite) OR stand up "ACE Test LLO" org
4. ☐ Retry F1: `commcare_create_repeater` for OCS User Registration + Trigger Bot (FormExpressionRepeater)
5. ☐ Retry F2: `commcare_create_inbound_api` for Session Completion + 24 hr Expiry
6. ☐ Retry F3: `commcare_set_user_fields` to add `cohort_id` field on test
7. ☐ Linked-app copy manually OR build atom — for F4
8. ☐ Retry F4 + F5: Connect opp + payment unit + activation
9. ☐ Mark F6 + F7 as deferred V1.5
10. ☐ Run `/ace:interview-opp-verify` and grade the cohort
