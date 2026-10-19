---
name: solicitation-google-form
description: >
  Mirror a labs solicitation into a public Google Form and import its responses. Needs a
  solicitation id.
---

# Solicitation Google Form

Makes a Google Form whose questions are a labs solicitation's questions, opens it so anyone
with the link can answer, and later imports each submission into the solicitation with
`create_response`. The team runs EOIs this way today. The labs solicitation stays the record:
the form is only a door into it.

> **Off by default. This is not the norm for runs.** Inside `/ace:run` the skill runs only when
> `run_state.optional_steps.google_form` is true (`--with google_form`, or `labs_e2e`). A run
> that did not ask for a form gets none, and nothing downstream needs one. Outside a run it
> runs only when the operator has said, in this request, that this form should be public.

Platform facts: [`playbook/integrations/google-forms.md`](../../playbook/integrations/google-forms.md)
(publishing does not open a form; the Drive permission does) and
[`connect-labs.md`](../../playbook/integrations/connect-labs.md) § Solicitations, responses, reviews,
awards. Shared Phase 8 conventions: [`_solicitation-template.md`](../_solicitation-template.md).
LLO-facing wording: [`_terminology.md`](../_terminology.md).

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `solicitation_id` | the call to mirror, read live with `get_solicitation` | explicit arg; default: run_state `phases.solicitation-management.products.solicitation.solicitation_id` |
| `public_form_decision` | the operator's decision that this form is public | default: run_state `optional_steps.google_form: true`; outside a run, explicit arg naming who decided |
| `parent_folder_id` | where the form lives (a Shared Drive folder) | explicit arg; default: the run's `8-solicitation-management/` folder |
| `deny_list` | parties that must never appear in LLO-facing text | explicit arg; default: exactly what `solicitation-seed-responses` § Process step 2 resolves: the opp's `inputs/confidentiality.yaml` `llo_facing_deny_list:` (parsed with `normalizeDenyList`) plus any "do not reference/mention <party>" instruction in the operator brief or the PDD; `[]` only when the opp declares none |
| `mode` | `create` (default), `--import`, or `--close` | explicit arg |

No `run_state.yaml` is required when every parameter is passed explicitly. The record (§
Products) is the state between `create` and `--import`.

## Products

- **Record** `8-solicitation-management/solicitation-google-form_record.md` (role `record`). Its
  YAML frontmatter is the state this skill and its QA read:

  ```yaml
  solicitation_id: 4242
  form_id: <id>
  edit_url: https://docs.google.com/forms/d/<id>/edit
  responder_url: https://docs.google.com/forms/d/e/<…>/viewform
  status: open            # open | closed
  question_map: {<form question_id>: <solicitation question id>}   # incl. __org_name / __contact_name / __contact_email
  deny_list_source: <where the list came from, or "none declared">
  imported:
    - {form_response_id: <id>, labs_response_id: <id>, imported_at: <iso>}
  ```

  The body below the frontmatter is for people: the responder link, what the form asks, and
  one line per import with any problems found.
- **run_state** (inside a run): `phases.solicitation-management.products.solicitation.google_form:
  {form_id, responder_url, edit_url}`, written with `update_yaml_file` `merge: 'deep'`.
- **Labs responses** created by `--import`, one per form submission.

## Process: create

1. **Gate.** Inside a run, read `run_state.optional_steps` and stop with "google_form not
   requested; nothing to do" unless `google_form` is true. Outside a run, stop unless the
   request carries the operator's public-form decision. A public form is an outward-facing act
   (anyone who finds the link can submit), so it never happens by inference.
2. **Read the call live** with `get_solicitation({solicitation_id})`: `title`, `description`,
   `application_deadline`, `questions[]`, `is_public`. The owner reads its own unlisted call by
   id alone. Never build the form from a cached copy.
3. **Load the deny list** (§ Inputs), the same way `solicitation-seed-responses` does, so the form
   and the seeded answers are held to one list. Record where each entry came from as
   `deny_list_source`.
4. **Check for an existing record** in the parent folder. If one exists with a `form_id`, do not
   create another: go to step 7 and verify it. `forms_create_from_spec` also refuses a
   same-named form, so a re-run never duplicates.
5. **Build the spec** with the lib, never by hand:

   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/form-from-solicitation.ts" spec --input <file>
   ```

   The input is `{solicitation: {id, title, description, application_deadline, questions},
   visibility: is_public ? 'public' : 'private', deny_list}`. The lib:
   - puts three identity items first (organisation, contact name, contact email), so an import
     can attribute each submission;
   - maps `text` → short answer, `textarea` → paragraph, `number` → short answer with "Enter a
     number.", `multiple_choice` → radio;
   - ends every answerable item's description with `[ref: <question id>]`, the join key;
   - starts a private call's form with the demonstration banner;
   - **refuses** (exit 2) if any respondent-facing text (name, title, description, an item's
     title or description, an option) names a deny-listed party. Do not edit around a refusal.
     Fix the solicitation text with `solicitation-edit` first, because the same words are in
     the call.
6. **Create** with `forms_create_from_spec({parentFolderId, name, title, description, items})`.
   It comes back unpublished. Save the result to a local file, then build the join:

   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/form-from-solicitation.ts" question-map --spec <spec.json> --created <result.json>
   ```

7. **Publish and open it**: `forms_set_publish_settings({formId, isPublished: true,
   isAcceptingResponses: true, anyoneWithLinkCanRespond: true})`. Publishing alone leaves the
   responder link at 401 for anyone outside the drive (live, 2026-10-18); the
   `anyoneWithLinkCanRespond` permission is what opens it. If the Shared Drive's policy refuses
   the `anyone` permission, the atom surfaces that error: report the form as **not public** and
   stop. Never record it as open.
8. **Prove it is open.** Fetch the responder link with no cookies:
   `curl -s -o /dev/null -w '%{http_code}' '<responder_url>'`. Anything but `200` means it is
   not open; report the status and stop.
9. **Write the record** (§ Products) with `drive_create_file` into the parent folder, then the
   run_state products block when a run is bound.
10. **Run `solicitation-google-form-qa`.**

## Process: `--import`

Run before `solicitation-review`, so the review sees every submission. Safe to run as often as
needed.

1. **Read the record.** No record means no form; stop.
2. **Read submissions**: `forms_list_responses({formId})`.
3. **Plan the import** with the lib:

   ```bash
   npx tsx "$CLAUDE_PLUGIN_ROOT/scripts/form-from-solicitation.ts" import-plan --input <file>
   ```

   The input is `{solicitation_id, questions (from a fresh get_solicitation), question_map,
   responses, already_imported: record.imported[].form_response_id}`. The plan skips anything
   already imported and does not import a submission with no organisation, name or email,
   because it cannot be attributed. It imports, but reports, a missing required answer, a
   non-number in a number question, and an answer to an item that is not in the map.
4. **Guard the crash window.** Before each create, `list_responses({solicitation_id})` and skip a
   submission whose `org_name`, `submitted_by_email` and `submission_date` already match a labs
   response. That covers a create that succeeded just before a record write failed.
5. **Create each response** with `create_response(payload)`. The respondent's own organisation
   name, name and email are entered as given; nothing is added or tidied. **Right after each
   create**, append `{form_response_id, labs_response_id, imported_at}` to the record's
   `imported` list. One write per response, so a stop mid-import loses nothing.
6. **Report** what was imported, skipped and flagged, in the record body and the reply.
7. **Re-run `solicitation-google-form-qa`.**

Real people may answer a public form, even one on a demonstration call; the banner says so.
Their submissions are entered as received. They are not synthetic, so they never get the
`[Synthetic]` suffix `solicitation-seed-responses` uses.

## Process: `--close`

`forms_set_publish_settings({formId, isPublished: true, isAcceptingResponses: false})`. The link
keeps working and shows the form as closed. Set the record's `status: closed`. Close the form
when the solicitation closes, or when the operator asks. `sweep-drive` does the same for a
form left open.

## MCP Tools Used

- ace-gdrive: `forms_create_from_spec`, `forms_set_publish_settings`, `forms_list_responses`,
  `get_google_form_definition` (QA), `drive_create_file`, `drive_update_file`, `drive_read_file`,
  `drive_list_folder`, `update_yaml_file`
- connect-labs: `get_solicitation`, `list_responses`, `create_response`

## Existing objects

- **The form never replaces the solicitation.** Labs keys answers by question id. Editing the
  solicitation's questions after the form exists breaks the join; `-qa`'s
  `every_question_mirrored` fails. Rebuild the form under a new name rather than editing items by
  hand.
- **Editing a live form by hand** can drop an item's `[ref: …]` line, and answers to that item
  then cannot be imported. `-qa`'s `form_items_carry_refs` reads the live form to catch it.
- **A public form stays reachable** until it is closed. Close it with `--close` when the call
  closes.

## Mode Behavior

- **Auto:** with the public-form decision in hand (step 1), runs create end to end.
- **Review:** shows the built spec (step 5) and waits before step 6.

## Dry-Run Behavior

With `--dry-run`, run steps 1–5 and write the spec into the record body. Create, publish and
import nothing.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR5b): mirror, open to anyone with the link, import by `[ref: …]`, deny-list refusal | ACE (optional labs E2E) |
