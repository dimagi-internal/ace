---
name: llo-directory-add
description: >
  Add one organisation and its contact to the Connect LLO Directory sheet from an inbound lead. Use when a member asks ACE to add an org to the directory.
disable-model-invocation: false
---

# LLO Directory Add

Turns one inbound "add this org to the LLO Directory" request into **one
Organizations row and one Contacts row** in the Connect LLO Directory sheet,
read back before anyone is told they exist. The usual input is a
connect.dimagi.com Contact Us / HubSpot lead that a teammate forwards to ace@
(the first was Matt Theis's Heart for Humanity Initiative lead, thread
`1a13cd3b541fd3ab`, 2026-10-14). dimagi-internal/ace#2920.

This skill handles a single, explicit request from a member. Whether ACE
maintains the network directory in general (bulk reconciliation, EOI join
dates) is an open product call, parked on #2152. Don't stretch this skill to
cover that.

## The layout is connect-labs', read live, never copied here

connect-labs is the directory's real consumer, and **its parser is the
contract**. Every run reads that contract from connect-labs `main`:

| What | Where (connect-labs, on `main`) |
|---|---|
| Sheet id, tab names | `connect_labs/marketplace/directory.py`: `DIRECTORY_ID`, `ORGANIZATIONS_TAB`, `CONTACTS_TAB` |
| Org columns labs requires, plus the optional HQ town | `directory.py`: `ORG_COLUMNS`, `HQ_CITY` (parsed by `parse_organizations`) |
| Contact columns labs requires | `directory.py`: `CONTACT_COLUMNS` (parsed by `parse_contacts`) |
| How a header matches (case, a bracketed note, Organisation/Organization) | `directory.py`: `_header_key`, `Columns` |
| What counts as a duplicate org | `connect_labs/marketplace/quality.py`: `_fold` + `audit` (`near_duplicate_org`) |
| How a sheet edit reaches labs | `connect_labs/marketplace/management/commands/marketplace_import.py` (`import_directory`, `handle`) |

`scripts/llo-directory.ts` fetches those modules with `gh api` at run time.
`lib/llo-directory.ts` parses the constants out of the source. It also refuses
to run if connect-labs has changed `_header_key` or `_fold` since ACE ported
them. **Never copy the sheet id, the tab names, labs' required-column lists or a
column letter into this file or a script.** A copied `ORG_COLUMNS` would bring
back the drift this skill exists to avoid. The header names quoted below show
which precedent cell to follow. Match each one against the live header row
before using it. *Enforced:* `test/skills/llo-directory-add-live-layout.test.ts`.

Columns move because people maintain the sheet by hand. So every cell is placed
**by its header text** in the live header row, never by position.

## Inputs

- The lead: a forwarded email or form submission (thread id). Its fields are
  the only facts about the org, along with the org's **own website**.
- The requester (the member who forwarded it). Their name goes in the org notes.

## Process

### 1. Read the contract and the live sheet (read-only)

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/llo-directory.ts" contract
```

This prints `connectLabsSha` (the connect-labs `main` commit) and the sheet id, tabs and required
columns as of that sha. A non-zero exit is a hard stop: the contract moved, a
ported rule changed, or a required header is gone. Quote the message to the
operator. Don't work around it.

Then read the two live header rows. Use the header text exactly as the sheet
has it, including the columns labs doesn't require (the ones ACE fills are
listed below):

```bash
gog sheets get <DIRECTORY_ID> "<ORGANIZATIONS_TAB>!1:1" -a ace@dimagi-ai.com --client "$(canopy email client --repo .)" -j --results-only
gog sheets get <DIRECTORY_ID> "<CONTACTS_TAB>!1:1"      -a ace@dimagi-ai.com --client "$(canopy email client --repo .)" -j --results-only
```

### 2. Draft the two rows, keyed by live header

Write `org.json` and `contact.json` (scratchpad). Each one maps live header
text to a value. **Fill a cell only from the lead or the org's own website.
Leave everything else blank.** Never infer team size, FLW counts, year of
establishment, whether the org has used Connect, an MSA or a work order. A blank
is honest: labs stores a blank as unknown. A plausible guess gets treated as
fact on the marketplace page (`docs/learnings/2026-05-12-no-inferred-backstory.md`).

Follow the precedent rows: Organizations row 240 (EME-RDC) and row 241 (HHI),
and Contacts row 204. **Re-read those rows live before copying their wording,**
because the sheet is hand-maintained.

- **Source column** (on Organizations it is the EOI/source column, *"EOIs Applied
  for (Add Link to EOI)"* at the time of writing). For a forwarded connect-info
  lead it reads `inbound email connect-info@dimagi.com`. Add the form and date
  when the lead has them, e.g.
  `inbound email connect-info@dimagi.com (HubSpot Contact Us form, 2026-10-13)`.
- **Organization Notes**: what the org said about itself and what it asked for,
  in a sentence or two, ending with `Added by ACE at <requester>'s request, <YYYY-MM-DD>.`
- **HQ City / HQ Basis / HQ Source** (Basis and Source are next to HQ City).
  - HQ City is `<Town>, <Country>`.
  - HQ Basis is the confidence plus the evidence:
    `high: Website Contact Us gives the office address as …`. When nothing names
    a town, write `not found: <what was checked>` and leave HQ City blank. Don't
    pick the capital.
  - HQ Source is the URL the evidence came from.
  - The town is what places the org on the labs network map (connect-labs
    `docs/marketplace-hq-sweep.md`), so a wrong one is worse than none.
- **Formula columns: leave them out.** Some columns are formulas, not data.
  On Organizations, *"Email addresses from Contacts sheet"* is a
  `TEXTJOIN(FILTER(Contacts!…))` over the Contacts tab. Never draft a value for
  one: a literal freezes the cell, so a contact added later never shows up
  (ace#2957). `plan` reads the precedent row with `--render FORMULA`, copies each
  formula to the new row with its row number moved, and refuses a drafted value
  in any formula column.
- **Contacts row**:
  - `Organization Name` must equal the org row's **exactly**, because labs joins
    on it. `plan` refuses a mismatch.
  - `Main POC` is `Yes` for the sender.
  - `Email Address` is required, since labs drops a contact without one.
  - `Contact Notes` says how they arrived, e.g.
    `Inbound via connect.dimagi.com Contact Us form (2026-10-13).` An org phone
    from the website goes here, not in `Phone Number`, unless it is the
    person's own.

### 3. Plan: duplicates, target rows, emptiness (read-only)

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/llo-directory.ts" plan --org org.json --contact contact.json
```

`plan` does the following, without writing anything:

- **Duplicate check.** It checks the name against every existing org with labs'
  own `_fold` (case, accents and spacing folded), so ACE and labs agree on what a
  duplicate is. It also checks for the same website host under a different
  spelling. A hit means **stop**: report the existing row to the requester and
  offer to update it. Never add a second row.
- **Target rows.** Each target row is computed from the **real last filled row**
  of that tab's name column (`lastFilledRow`, 1-based). The 2026-10-14
  off-by-one came from mixing a 0-based count with 1-based sheet rows.
- **Emptiness.** It reads each target row across the full header width and
  reports `target_row_empty`.
- **Writes.** It prints `ready` and `writes`, the exact-range writes as data
  (`range`, `input`, `values`). They are **exact-range writes**, never `append`.
  Each row is one `RAW` write across the header width. `RAW` matters: under
  `USER_ENTERED` a value like `+234 …` is parsed as a formula. Then there is one
  single-cell `USER_ENTERED` write per formula column, carrying the precedent
  row's formula.

If `ready` is false, don't write. Report why.

### 4. Approval gate, then write

The directory is shared, hand-maintained state, so the write is
**approval-gated** like any shared-state change. Show the operator:

- the two drafted rows, as header → value
- the target row numbers
- the duplicate-check result
- the connect-labs sha the layout was read at

On an explicit yes, write with `apply`, using the same two files:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/llo-directory.ts" apply --org org.json --contact contact.json
```

`apply` re-runs the plan and refuses (exit 1, nothing written) unless it is
still `ready`. It passes each write to gog as an argument array, with no shell,
so a note containing `"` or `\` reaches the sheet verbatim. Then it runs
`verify` on both rows itself. **Never extract the writes from `plan`'s JSON
and run them through a shell.** That path broke on a quoted note and wrote
nothing (ace#2956). If the plan changed between approval and `apply` (different
target rows), show the operator the new plan before re-running. Inside a turn,
review posture parks the plan (verbatim) on the thread's board task until the
operator approves (`skills/inbox-triage` § parked drafts).

### 5. Read back both rows (before any claim)

`apply` prints `verify`'s result. To re-check later:

```bash
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/llo-directory.ts" verify --org org.json --org-row <n> --contact contact.json --contact-row <m>
```

`verify` exits 0 only when both rows read back cell for cell as written. It
compares each formula cell's `--render FORMULA` text with the precedent's
formula, moved to that row. Nothing
may say the rows exist until it passes. That includes the reply, the board card
and the turn close-out. On a diff, report the diff. Don't re-write blind.

### 6. Reply to the requester (approval-gated)

The reply is outbound, so it goes through `skills/agent-turn-review` and the
send gate (`bin/ace-email`, never raw gog). It says:

- the two row numbers, and what was left blank and why
- **that labs does not see the org yet.** connect-labs never writes the sheet.
  It reads it with `marketplace_import`, which runs daily on beat and can be run
  by hand (the connect-labs `Run Labs management command` workflow). The org
  appears on the labs marketplace after the next import, not when the sheet
  changes. Check the import's current trigger in connect-labs before stating a
  schedule.

Mark the thread read only after the reply is sent (`bin/ace-mark-read`).

## Guardrails

- Never edit or delete an existing row. Corrections to someone else's row are
  the sheet owner's call; offer them.
- Never fill a field from anything except the lead or the org's own site.
- One org per run. A list of orgs is the bulk-maintenance question (#2152). Ask.

## Related skills

- `inbox-triage`: where the forwarded lead arrives. This skill is the action for that thread.
- `agent-turn-review`: the pre-send audit for the reply.
- `email-communicator`: the send path and comms-log contract.

## Terminology

**The platform is `Connect`, never `CommCare Connect`**, in the reply and in
every cell this skill writes. The full rule, including the carve-outs for the
CommCare mobile app, CommCare HQ and code-level identifiers, is in
[`skills/_terminology.md`](../_terminology.md).
