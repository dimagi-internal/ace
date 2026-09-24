---
name: gdoc-email-drafts
description: Put draft emails in a Google Doc as email blocks. A person clicks a block's Gmail icon to open it as a filled-in Gmail draft. Use for any Doc of emails a human will send.
disable-model-invocation: false
---

# Draft emails in a Google Doc

When a person will send the emails, they belong in a Doc as **email blocks**. Each block is the
To / Cc / Bcc / Subject / Body table that Docs shows with a **Gmail icon in the right margin**.
Hover the block, click the icon, and Gmail opens a draft with every field filled in. ACE writes
the drafts, and the person reviews them and sends them.

A bold `Subject:` line followed by a quoted body is **not** a draft email. It looks like one,
but clicking it does nothing. Always use the block.

## The tool

`docs_insert_email_blocks` (ace-gdrive; exact signature in `docs/atom-schemas.md`). It runs as
ACE's own service account, which already owns every doc ACE creates, so there is no step to
share the doc with anyone. It is ported from chrome-sales' `docs_insert_email_block`, which
Eva's `email-macros` skill uses. Do not call the chrome-sales tool from ACE. It runs as a
different service account, which needs writer access on each doc and leaves you to do the
index math yourself.

## Procedure

1. **Write the doc with an anchor wherever a block goes.** Build the markdown for
   `drive_create_doc_from_markdown` (on a Shared Drive: a run folder, or a find-or-create
   folder under `ACE_DRIVE_ROOT_FOLDER_ID` from `.env.tpl` when there is no opportunity). Put
   each email's heading and context first. Then, alone on its own line with a blank line
   either side, write the anchor `@@EMAIL_<key>@@`. The key may use letters, digits, `_` and
   `-`, and each key appears once. Do **not** write the email text in the markdown; the block
   carries it.

   ```markdown
   ## Acme Health — invitation

   @@EMAIL_acme@@
   ```

   Never put the anchor on a heading line. The block would take the heading's 18pt font, and
   the tool refuses it for that reason.

2. **Call `docs_insert_email_blocks` once, with every block:** `documentId` plus
   `blocks: [{anchor, to, cc?, bcc?, subject, body}]`. In `body`, `\n` separates
   paragraphs. When no address is known, leave `to` empty or put a visible placeholder like
   `[Name]`. Never guess an address.

   The tool checks every anchor before it writes anything. It fails, and changes nothing,
   when an anchor is missing, duplicated, or on a heading. It then inserts the blocks
   last-first and deletes the anchor tokens it used. Any `@@EMAIL_*@@` token that no block
   asked for comes back in `unusedAnchors` and stays in the doc, where a reader will see it.

3. **Insert the blocks LAST.** Re-publishing markdown over the doc with
   `drive_create_doc_from_markdown` or `drive_update_file` rewrites the whole body and wipes
   the blocks. To change one email afterwards, rebuild the doc: publish the markdown, then run
   step 2 again.

4. **Share the doc as the procedure you came from says.** Lead with the run's ace-web page when
   the doc belongs to a run (CLAUDE.md § Conventions), and reply with the link and a
   one-line count. Do not paste the emails into the reply; they are in the doc.

## What this skill does not do

- **Send.** The Gmail icon is the send step, and it belongs to a person. ACE's own send path
  is [[email-communicator]], which is approval-gated and meant for ACE's own correspondence,
  not for drafts a human sends.
- **Add a margin icon to anything but a block.** A plain link, a bold subject line or a quoted
  body gets no icon.

## Validating a change to the helper before the MCP restarts

Compiled MCP code only takes effect after a full Claude restart. To exercise
`lib/docs-email-block.ts` against a live doc before that, run the script below. It uses the
same code as the atom and reads ACE's SA key from the plugin-data dir (or from
`GOOGLE_APPLICATION_CREDENTIALS`).

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/run-email-blocks.ts" <documentId> <blocks.json>
```

## Terminology

**The platform is `Connect`, never `CommCare Connect`**, in every email drafted this way. The
full rule, including the carve-outs for CommCare the mobile app, CommCare HQ and identifiers,
is `skills/_terminology.md`.

Used by: [[marketplace-outreach-doc]]. Related: `eva:email-macros` (the same result through
chrome-sales), `eva:gdoc-review` (a visual check worth running before a link goes out).
