---
name: solicitation-google-form-qa
description: >
  Pass/fail check of a solicitation's public Google Form.
---

# Solicitation Google Form QA

Structural checks on the form `solicitation-google-form` made. Binary verdict: pass / fail / incomplete. 8 static checks, run by `scripts/qa-run.ts` over `checks.ts`.

It checks the LIVE form and an anonymous fetch, not just the record, because the record says
what the producer meant to make and only the live reads say what a respondent meets. A form is
public, so a defect here is already in front of people. There is no `-eval`: the form is a
mirror of the solicitation, whose quality `solicitation-create-eval` grades. See
`skills/_qa-template.md` for the shared QA contract.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `record` | `solicitation-google-form_record.md` frontmatter | explicit file id; default: the run's `8-solicitation-management/` folder |
| `solicitation` | live `get_solicitation` (`is_public`, `questions`) | read live from `record.solicitation_id` |
| `form` | live `get_google_form_definition({formId})` | read live from `record.form_id` |
| `anonymous_http_status` | `curl -s -o /dev/null -w '%{http_code}' '<responder_url>'`, no cookies | measured at QA time |
| `deny_list` | the opp's deny list (`inputs/confidentiality.yaml` `llo_facing_deny_list:` plus brief/PDD instructions) | same resolver as the producer; `[]` when none is declared |
| `run_products_google_form` | run_state `phases.solicitation-management.products.solicitation.google_form` | run_state when a run is bound; `null` when none is |

## Products

- `8-solicitation-management/solicitation-google-form-qa_result.yaml`, the QA result per
  `lib/qa-types.ts`. Outside a run, return it inline.

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `record_complete` | static | Record carries `form_id`, `edit_url`, `responder_url`, `solicitation_id` and a non-empty `question_map` | rewrite the record from the create result |
| 2 | `every_question_mirrored` | static | `question_map` covers exactly the live solicitation's question ids plus the three identity items | rebuild the form (new name) from the current call |
| 3 | `form_items_carry_refs` | static | The live form's items carry unique `[ref: …]` lines that match `question_map` | restore the edited item, or rebuild |
| 4 | `banner_when_private` | static | A private call's form description starts with the demonstration banner | restore the banner |
| 5 | `no_deny_listed_party` | static | No respondent-facing text on the live form names a deny-listed party | edit the form now, then the call |
| 6 | `responder_link_open` | static | An anonymous fetch of the responder link returns 200, unless the form is closed | `forms_set_publish_settings` with `anyoneWithLinkCanRespond: true` |
| 7 | `products_recorded` | static | run_state `google_form` matches the record (skipped when no run is bound) | rewrite the products block |
| 8 | `imports_unique` | static | No form response or labs response appears twice in `imported` | delete the duplicate labs response, fix the record |

## Process

1. Read the record frontmatter, then `get_solicitation`, `get_google_form_definition` and the
   anonymous fetch (§ Inputs). Inside a run, read the products block; outside one, use `null`.
2. Write the six inputs as one JSON evidence bundle (shape documented at the top of `checks.ts`)
   to a local file.
3. Run the checks:

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-run.ts" \
     --skill solicitation-google-form-qa --artifact <bundle.json> \
     --target <opp>/<run-id> \
     --capture-path 8-solicitation-management/solicitation-google-form_record.md
   ```

4. **Write the result through the shared writer**, never by hand. Put one outcome per check
   (`{check, type: "static", result: {pass, detail, auto_fix_hint}}`) in a local
   `outcomes.json`, then:

   ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-result.ts" write \
     --skill solicitation-google-form-qa --target <opp>/<run-id> \
     --capture-path 8-solicitation-management/solicitation-google-form_record.md \
     --outcomes outcomes.json --out <local result.yaml>
   ```

   Upload that file to § Products. A hand-written shape is refused by the ace-gdrive write guard
   (`skills/_qa-template.md` § QA result YAML contract).
5. On `fail`, a check 5 or check 6 failure is urgent: the form is public. Fix it before anything
   else.
6. A record that does not exist is `incomplete`, not `fail`: there is no form to check.

## MCP Tools Used

- ace-gdrive: `drive_read_file`, `get_google_form_definition`, `drive_create_file`
- connect-labs: `get_solicitation`

## Mode Behavior

Same in every mode: read, check, write the result. It never changes the form.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR5b): 8 checks over the live form, an anonymous fetch and the record | ACE (optional labs E2E) |
