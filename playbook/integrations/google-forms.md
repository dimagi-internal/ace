# Google Forms

How ACE creates, publishes and reads Google Forms. The atoms are on `ace-gdrive`:
`forms_create_from_spec`, `forms_set_publish_settings`, `forms_list_responses`, plus the
read-only `get_google_form_definition`. Grep [`docs/atom-schemas.md`](../../docs/atom-schemas.md)
for their exact parameters.

A form is an outward-facing surface. A public form collects real submissions from anyone
who finds the link, so a run creates one only when the operator asked for it. For
solicitations that is the `google_form` optional step; it is never the default.

## What was verified live (2026-10-18)

Run as `ace-service-account@connect-labs.iam.gserviceaccount.com` against a scratch folder
on ACE's Shared Drive. The probe created a form, filled it, published it, opened it to
anyone with the link, read its (empty) responses, closed it and trashed it.

| Step | Observed |
|---|---|
| Forms API on project `connect-labs` | Enabled. `forms.get` of a made-up id answers 404, not 403. |
| `drive.files.create` with mimeType `application/vnd.google-apps.form` and a Shared Drive parent | Creates the form on the Shared Drive (`driveId` set). |
| A form made that way, before any edit | Already holds **one blank "Untitled Question"**. Left alone, respondents see it at the end of the form. `forms_create_from_spec` deletes it in the same `batchUpdate`. |
| `forms.batchUpdate` on that form (`updateFormInfo` + `createItem` ×2) | Fills it with no further step. The replies carry each item's `itemId` and `questionId`. |
| `publishSettings` right after creation | `{publishState: {}}`, so the form is **unpublished**. |
| Anonymous GET of `responderUri`, unpublished | **401** |
| Anonymous GET, after `setPublishSettings` `{isPublished: true, isAcceptingResponses: true}` | **Still 401** |
| Anonymous GET, after Drive `permissions.create {type: anyone, role: reader, view: published}` | **200**, and the page shows the form |
| `permissions.list` without `includePermissionsForView: 'published'` | Does **not** list that permission. With it, `{id: anyoneWithLink, type: anyone, role: reader, view: published}`. |
| `forms.responses.list` on a form with no responses | `{}` (no `responses` key) |
| Close: `{isPublished: true, isAcceptingResponses: false}` | Echoes `publishState: {isPublished: true}` (the false field is omitted). |

## Creating a form

Use `forms_create_from_spec`. It refuses a parent that isn't on a Shared Drive, checks every
item before writing anything, and refuses when a form of the same name already exists in the
folder, so a re-run never makes a duplicate.

**Never use `forms.forms.create`.** It puts the form in the service account's own My Drive,
which has no storage quota. That is the same trap as the Shared-Drive parent rule in
CLAUDE.md § Gotchas. Creating the file with the Drive API in the right folder avoids it.

Item kinds: `short_answer`, `paragraph`, `radio`, `checkbox`, `dropdown`, `scale`, `date`,
`section` (a page break) and `info` (a text block with no answer). The result maps each item
to its `question_id`. Keep that mapping to read answers back, or carry your own id in the
item `description`. `solicitation-google-form` does the latter.

## Publishing, and who can respond

Two settings, and both matter:

1. **Publish state** (`forms.setPublishSettings`). Forms created through the API stay
   unpublished until this is set. `isAcceptingResponses: true` with `isPublished: false` is
   rejected by the API, and the atom refuses it before calling.
2. **Responder access** (a Drive permission). Publishing alone lets nobody outside the drive
   respond. "Anyone with the link can respond" is the permission
   `{type: anyone, role: reader, view: published}`. Drive reports its role as
   `publishedReader`. Pass `anyoneWithLinkCanRespond: true` to add it; it is idempotent.
   Pass `false` to remove it; omit it to leave access alone.

To **close** a form, pass `isPublished: true, isAcceptingResponses: false`. The link keeps
working, but it shows the form as closed. `sweep-drive` closes forms this way.

## Reading responses

`forms_list_responses` walks every page and returns answers keyed by `question_id`, with
the question titles alongside. Text and choice answers come back as their values, file
uploads as Drive file ids. `since` (RFC3339) limits it to recent submissions, which helps an
importer that runs more than once.

## Setup and failure modes

- **Scopes:** `forms.body` and `forms.responses.readonly`, alongside `drive`. These are
  requested by the service account itself; no domain-wide delegation is involved.
- **Forms API disabled** shows up as a 403 mentioning `SERVICE_DISABLED` / "has not been used
  in project". `/ace:doctor`'s `forms_api` probe names it and prints the enable link for the
  SA's project
  (`https://console.cloud.google.com/apis/library/forms.googleapis.com?project=connect-labs`).
  A project admin has to enable it.
- **Shared Drive sharing policy:** if the Shared Drive forbids sharing outside the domain,
  the `anyone` permission is refused. The atom surfaces that error rather than reporting
  the form as public.
- **MCP restart:** these atoms run inside the `ace-gdrive` subprocess. After an update that
  changes them, restart Claude Code fully (CLAUDE.md § MCP changes need a full Claude
  restart).
