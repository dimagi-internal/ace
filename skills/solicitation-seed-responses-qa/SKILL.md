---
name: solicitation-seed-responses-qa
description: >
  Pass/fail check of seeded synthetic responses against live labs reads. Static, no LLM.
disable-model-invocation: false
---

# Solicitation Seed Responses QA

Structural checks on what `solicitation-seed-responses` left on labs. Binary verdict: pass / fail /
incomplete. 7 static checks, runnable through `scripts/qa-run.ts` against the importable
`checks.ts`. No LLM.

The checks read what labs actually holds, not what the roster claims. The artifact is one
**evidence bundle** this skill assembles from live reads (§ Process step 4), because the runner
passes the artifact text only. Quality of the ranking these responses feed is graded by
`solicitation-review-eval`; this skill only answers "is the seed what it should be".

Shared contract: `skills/_qa-template.md`.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `solicitation_id` | the seeded call | explicit arg; default: run_state `phases.solicitation-management.products.solicitation.solicitation_id` |
| `roster` | the planned respondents | explicit arg; default: `8-solicitation-management/solicitation-seed-responses_roster.md` |
| `expected_count` | how many responses there should be | explicit arg; default: run_state `optional_steps.seed_responses.count` |
| `llo_org` + its Connect id | the winner binding to check | explicit arg; default: the preflight `connect_orgs.llo_org`, id from `labs_context` |
| `deny_list`, `real_org_names` | the confidentiality and impersonation rules | the same sources `solicitation-seed-responses` § Process steps 2 and 4 used (the roster lists the deny list in force) |

## Products

- `8-solicitation-management/solicitation-seed-responses-qa_result.yaml`: QA result per `lib/qa-types.ts`.

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `response_count_matches` | static | The roster has `expected_count` rows and every `response_id` exists in `list_responses`. | re-run the producer; it skips existing respondents |
| 2 | `required_answers_present` | static | Every required question is answered, except by a persona flagged `missing_answer`, which must actually skip one. | fix the persona's answers and re-seed it |
| 3 | `winner_bound_to_llo_org` | static | Exactly one winner, whose live response has `llo_entity_id` = `llo_org` and `org_id` = its Connect id. | re-create the winner response with both fields |
| 4 | `no_real_org_collision` | static | Every fictional respondent ends with ` [Synthetic]` and matches no real organisation. | rename and re-seed |
| 5 | `no_deny_list_party` | static | No response's org name, submitter name or answer names a deny-listed party. | remove the party and re-seed |
| 6 | `solicitation_still_private` | static | `get_solicitation` reads `is_public: false`. | unlist at once with `solicitation-edit` |
| 7 | `synthetic_emails_only` | static | Every submitter address is ACE's mailbox tagged `+synthetic-<n>`. | re-seed with `syntheticEmail` |

The functions live in `skills/solicitation-seed-responses-qa/checks.ts`. Each returns a
`QACheckResult`. An unreadable bundle fails every check rather than passing vacuously.

**Adding a check:** append to `CHECKS`, add a row above, add a test in
`test/skills/solicitation-seed-responses-qa/checks.test.ts`.

## Process

1. **Read the solicitation live:** `get_solicitation(solicitation_id)`. Keep `is_public` and
   `questions[]`.
2. **Read the responses live:** `list_responses(solicitation_id)`. Keep, per response, `id`,
   `org_name`, `llo_entity_id`, `org_id`, `submitted_by_name`, `submitted_by_email` and
   `responses`.
3. **Read the roster** with `drive_read_file` (default `text/plain`), and take each row's key,
   `response_id`, org name, flags and winner mark.
4. **Assemble the evidence bundle** as YAML in a local temp file:

   ```yaml
   solicitation: { id: <int>, is_public: <bool> }       # step 1
   expected_count: <int>
   mailbox: <config/agent.json email>
   winner: { llo_entity_id: <llo_org>, connect_org_id: <int> }
   questions: [{ id, required }]                         # step 1
   real_org_names: [...]
   deny_list: [...]
   roster: [{ key, response_id, org_name, flags: [...], winner: true|false }]   # step 3
   responses: [...]                                      # step 2
   ```

5. **Run the checks:**

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-run.ts" \
     --skill solicitation-seed-responses-qa \
     --artifact "$BUNDLE" \
     --target "<opp>/<run-id>" \
     --capture-path "8-solicitation-management/solicitation-seed-responses_roster.md"
   ```

6. **Write the result** through the shared writer (§ Writing the result) to
   `8-solicitation-management/solicitation-seed-responses-qa_result.yaml`.
7. **Return the verdict.** `pass`: the review can run. `fail`: hand each `auto_fix_hint` to the
   producer and re-run; **never proceed to `solicitation-review` on a failing seed**. Check 6
   failing is urgent: unlist first, then fix. `incomplete`: the solicitation or roster is
   missing; halt with the reason.

## Writing the result (shared writer — every `-qa` skill)

Write the result file through the shared writer, never by hand:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-result.ts" write \
  --skill solicitation-seed-responses-qa --target <opp>/<run-id> \
  --capture-path 8-solicitation-management/solicitation-seed-responses_roster.md \
  --outcomes <outcomes.json> --out <local result.yaml>
```

and upload that file. A result that evaluated nothing is a FAIL (`aggregateQAResult`,
`lib/qa-types.ts`), and ace-gdrive refuses any other shape (`INVALID_QA_RESULT`).

## MCP Tools Used

- connect-labs: `get_solicitation`, `list_responses`
- ace-gdrive: `drive_read_file`, `drive_create_file`
- Bash: `scripts/qa-run.ts`, `scripts/qa-result.ts`

## Mode Behavior

- **Auto / Review:** identical. QA is binary; there is no pause inside it.

## Dry-Run Behavior

Reads are unchanged, and the result is written (it is internal). With a dry-run producer there
are no live responses, so checks 1, 3 and 7 fail by construction. Report `incomplete` instead.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial skill (optional labs E2E PR4). Positive control built from the live probe captured on private call 1000003. | ACE team |
