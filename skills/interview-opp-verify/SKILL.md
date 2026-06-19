---
name: interview-opp-verify
description: >
  Read-only verifier for a configured Connect Interviews opportunity.
  Walks docs/connect-interviews/checklist-schema.yaml, calls the read
  atoms, and grades each rule pass / fail / unverifiable. Cross-system
  consistency checks (e.g. OCS custom action target URL == HQ Inbound
  API URL) are included.
disable-model-invocation: true
---

# Interview Opportunity Verify

Walk every rule in `docs/connect-interviews/checklist-schema.yaml` against a live opp and produce a verdict report.

## Slash command

```
/ace:interview-opp-verify <connect-opp-url>
```

Or with explicit args:

```
/ace:interview-opp-verify --opp <opp_id> --org <pm_org> --domain <hq_domain> --bot <experiment_id>
```

## Input

Resolved from the Connect opp URL: `/a/<org>/opportunity/<opp_id>/`. Skill fetches the opp, then derives:
- HQ downstream domain (from opp.learn_app.domain)
- OCS bot id (from connections + bot list — defaults to env OCS_INTERVIEWS_TEMPLATE_ID if there's only one)

## Products

- `ACE/<opp-name>/verify/<run-id>/report.md` — human-readable verdict report
- `ACE/<opp-name>/verify/<run-id>/verdict.yaml` — machine-readable per-rule pass/fail
- Exit code 0 if all green, 1 if any fail, 2 if any unverifiable items exist

## Process

The skill loads `docs/connect-interviews/checklist-schema.yaml` (in-repo) and iterates every item, calling the named `verify.atom` with the appropriate args.

### Sections walked (in order):

1. **per_program** — Connect program + LLO org membership + OCS team
2. **per_domain** — all the HQ plumbing + the OCS bot's structural pieces
3. **per_cohort** — apps, lookup rows, opp config, payment unit, conditional alert, OCS interview nodes
4. **per_user** — cohort_id is set on this cohort's FLWs (V1: only checks the opp's invited users)

### Verdict shapes:

- ✅ **pass** — atom returned matching state per the rule
- ❌ **fail** — atom returned and state mismatched
- ⚠️ **unverifiable** — atom doesn't exist yet (gap) OR returned an error we can't classify
- ⊘ **out_of_band** — rule explicitly marked as "humans must attest" (e.g. subscription tier)

### Cross-system checks

Some rules check consistency across systems. The verifier resolves IDs cohesively before grading:

- `ocs-bot-has-completion-action.target_url_matches: "@inbound-api-session-completion.url"` — verifier reads the HQ Inbound API URL, then checks the OCS custom action's `server_url + api_schema operationId path` resolves to the same URL.
- `opp-learn-app-linked.value: "@app-learn-copied.app_id"` — verifier reads the new linked-app id from the cohort spec, checks the opp's `learn_app.cc_app_id` matches.

### OCS rules — all read from one `ocs_inspect_chatbot` call

As of OCS PR #3536 (deployed 2026-06-09; refactored on FK relations in #3645 + #3652 on 2026-06-18), every OCS-side rule reads from a single `ocs_inspect_chatbot({ public_id })` call. The response shape is the OpenAPI `ChatbotInspect` schema served at `https://www.openchatstudio.com/api/schema/` — grep there for the field contract before paraphrasing. The mappings:

| Rule | Inspect payload path |
|---|---|
| `ocs-bot-has-router-node` | `pipeline.nodes[].type === "StaticRouterNode"` |
| `ocs-bot-has-llm-node` | `pipeline.nodes[].type === "LLMResponseWithPrompt"` (also `LLMResponse`) |
| `ocs-bot-has-python-node-session-state` | `pipeline.nodes[].type === "CodeNode"` |
| `ocs-bot-has-24hr-timeout-event` | `events.timeout_triggers[*].delay_seconds === 86400` ← **experiment-level, NOT a pipeline node** (this gap was the original driver for OCS #3458) |
| `ocs-bot-has-completion-action` | `pipeline.nodes[].custom_actions[*].name` matches `"Session Completion"`; `server_url` cross-checked vs HQ Inbound API URL |
| `ocs-bot-has-24hr-expiry-action` | `pipeline.nodes[].custom_actions[*].name` matches `"Expiry"` |
| `ocs-interview-nodes-per-cohort` | router node `params.keywords[]` includes every interview_id in `cohort.schedule` |
| `ocs-interview-source-material` | `pipeline.nodes[].source_material` + `indexed_collections[]` |

Call `ocs_get_me` first when running on a new machine: if `team.slug` doesn't match the team that owns the bot, `inspect` will 404 (looks like "bot doesn't exist" but is really "wrong team key").

### Multi-team — target a team other than `OCS_TEAM_SLUG`

The three observation atoms `ocs_get_me`, `ocs_list_chatbots`, and `ocs_inspect_chatbot` accept an optional `team_slug` argument. When supplied AND it differs from the configured default team (`OCS_TEAM_SLUG`), the MCP server looks up the matching token from `OCS_API_TOKEN_<SLUG>` env vars and uses it for that call only. Default-team calls (no `team_slug`) keep using `OCS_API_TOKEN` exactly as before — no behavior change for single-tenant workflows.

To verify a bot on a non-default team:

1. Mint a read-only `UserAPIKey` scoped to the target team via `/users/profile/` → API keys (uncheck "allow write").
2. Store it in 1Password under `AI-Agents` as `ACE - OCS REST API Key (<slug>)`.
3. Add to `.env.tpl`: `OCS_API_TOKEN_<SLUG_UPPER>=op://AI-Agents/<uuid>/credential` (slug uppercased, non-alphanumeric → `_`).
4. Run `bash bin/ace-setup --force-env` to inject.
5. Restart Claude Code so the MCP subprocess picks up the new env var.
6. Pass `team_slug: "<slug>"` on every OCS call in the verifier run.

A `team_slug` for which no token is registered surfaces a typed error naming the exact env var to add — so misconfigurations don't bleed into 401 mysteries.

### Report format

```markdown
# Interview Opp Verify — <cohort_id>

**Generated:** 2026-05-22 (run-id 20260522-0030)
**Opportunity:** https://connect.dimagi.com/a/<org>/opportunity/<opp_id>/
**HQ domain:** <slug>  **OCS bot:** <experiment_id>

## Summary

| Pass | Fail | Unverifiable | Out-of-band | Total |
|---|---|---|---|---|
| 38 | 2 | 5 | 3 | 48 |

## Per-section

### per_program (3 items)
✅ connect-program-exists — "ACE Interviews Test" found
⊘ llo-orgs-accepted-into-program — out_of_band (ACE-owned program has no external LLOs)
⊘ ocs-team-for-program — out_of_band (OCS_TEAM_SLUG=connect-ace confirmed by env)

### per_domain (24 items)
...

### per_cohort (25 items)
...

## Action items

For each fail:
- **conditional-alert-payment** — alert "<cohort_id> Payment Conditional Alert" not found on /a/<domain>/messaging/conditional/. Create manually (atom not yet built).

For each unverifiable:
- **ocs-interview-nodes-per-cohort** — atom gap (ocs_edit_pipeline_structure). Manually inspect the bot at <bot-url> and confirm each interview_id in the cohort's schedule has a router target.
```

## Process detail

1. **Resolve identifiers.** Given the opp URL, call `connect_get_opportunity` to fetch the opp; extract `learn_app.domain` as the downstream HQ domain.

2. **Load the schema.** Read `docs/connect-interviews/checklist-schema.yaml` from the plugin install dir; iterate per_program / per_domain / per_cohort / per_user items.

3. **Per item:**
   - If `verify.atom` is `null`, mark `unverifiable` with the item's notes.
   - If `verify.rule.type` is `out_of_band`, mark `⊘`.
   - Otherwise, call the atom with the rule's args (substituting `@<other-item-id>.field` references resolved from previously-graded items).
   - Apply the rule type: `exists`, `name_matches`, `property_equals`, `filter_matches`, etc.
   - Record the verdict.

4. **Write the report + verdict YAML.**

## Atom usage map (read-side only)

| Schema section | Atoms |
|---|---|
| per_program | `connect_list_programs`, `connect_get_program` |
| per_domain HQ | `commcare_list_apps`, `commcare_list_connections`, `commcare_list_inbound_apis`, `commcare_get_lookup_table`, `commcare_list_users` (for user fields presence) |
| per_domain OCS | `ocs_get_me`, `ocs_list_chatbots`, `ocs_inspect_chatbot` |
| per_cohort | `commcare_list_apps`, `commcare_get_lookup_table_rows`, `connect_get_opportunity`, `connect_list_payment_units`, `ocs_inspect_chatbot` |
| per_user | `commcare_list_users`, `commcare_get_user` |

## Unverifiable rules (gap-tagged)

Per `checklist-schema.yaml § atom_gaps`, these rules currently grade `unverifiable`:

- `ucr-*` rules — `commcare_list_ucr_expressions` atom ships, but verifier rule logic not yet wired (linked-domain push verification deferred)
- `repeater-*` rules — a commcare-list-form-repeaters atom (*not yet built*) is needed (only create exists)
- `custom-user-data` rule (cohort_id field exists) — `commcare_list_user_fields` atom ships, but verifier rule logic not yet wired
- `conditional-alert-payment` rule — a commcare-list-conditional-alerts atom (*atom code present in commcare.ts but registration deferred — see comment at line 510 of mcp/connect-server.ts*) is needed

**Closed since V1:** `ocs-interview-nodes-per-cohort` is now verifiable via `ocs_inspect_chatbot` (router params.keywords[] are read directly).

For V1 these grade `⚠️ unverifiable` with action-item prompts to operator. V1.5 ships the read atoms to fill these.

## Exit codes

- `0` — all rules pass or out_of_band
- `1` — at least one fail
- `2` — no fails but some unverifiable (operator should review action items)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Initial V1 — read-only verifier; ~80% of rules implementable with current atoms | ACE team |
| 2026-06-19 | Migrated every OCS rule (~8 rules) to a single `ocs_inspect_chatbot` call via OCS PR #3536. Closes the 24-hr `TimeoutTrigger` gap that drove our companion issue #3458. Adds `ocs_get_me` precheck for team scope. | ACE team |
