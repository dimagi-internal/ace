---
name: marketplace-outreach-doc
description: Draft one grounded outreach email per organisation for a marketplace EOI round, as a Doc with a one-click Gmail draft each. Use when asked for emails for the orgs on a marketplace page.
disable-model-invocation: false
---

# Marketplace outreach doc

One doc, one email block per organisation, each grounded in what that organisation has
actually done — delivered as blocks a human clicks to open in Gmail.

## Before anything: get the selection, do not ask for it

When this comes from the canopy agent panel, the page has already said which organisations
are on screen and which round is being looked at. Read it:

- `current_page` (canopy-web MCP) → the attached page's declared state.
  - `resource: "labs-marketplace://orgs"` → `visible_ids` are **org slugs**, and `filters`
    says how the person narrowed the list.
  - `resource: "labs-marketplace://rounds/<slug>"` → they are on one round's page, and
    `<slug>` is the EOI. `visible_ids` are the organisations that **already answered** it.

**Do not ask "which organisations?" when the page has told you.** Asking for what is on the
screen in front of someone is the failure this whole path exists to remove. If `current_page`
returns nothing (no panel, or the MCP server was still connecting), then ask — but say why.

**Mind which list you are working from.** On a round's page `visible_ids` are *existing
applicants*. "Invite these orgs to this EOI" from there usually means somebody else — the
network page's list, filtered. If the ask and the declared list disagree, say so in one line
and confirm, rather than drafting twenty emails to people who already applied.

## 1. Read the round, and the organisations

```
marketplace_rounds_list(slug="<the EOI>")           # connect_labs MCP
marketplace_orgs_get(slugs=[...], include_contacts=true)
```

From the round, use its **real** fields — `title`, `application_deadline`, `scope_of_work`,
`questions`, `contact_email`, `target_countries`. Never write a deadline, a scope or a
contact address from memory: a wrong deadline in an outreach email is worse than no email.

From each organisation, use `delivered_programs` (what they have actually run on Connect)
and `applied_programs` (what they asked for). That gap is the whole basis of a specific
email — and `countries`, `team_size`, `year_established` are there when they help.

**`include_contacts=true` only here, where writing to people is the point.** These are real
addresses and they persist in this transcript.

## 1a. When the ask does not fit the round, say so before writing

Check the round's `application_deadline` and, with `include_applicants`, whether the
organisations on screen have already submitted. Three cases come up:

- **Open round, orgs have not applied** — an invitation. The straightforward case.
- **Closed round, orgs already submitted** — an invitation makes no sense. Write a follow-up
  on their submission instead, and say in one line that you did and why. Leave what you do
  not know as a marked placeholder (`[DECISION / NEXT STEP]`) rather than inventing an
  outcome: the directory records who applied, never who was selected.
- **The ask and the screen disagree** — say which list you are working from and offer the
  alternative.

**Ask in the CHAT, not with a tool.** A widget turn is confined and `AskUserQuestion` is not
in its profile; the reply IS the question, so put it in the message. Reaching for the tool
costs a denied call and a turn.

Never silently write the email that does fit while the person asked for one that does not.

## 2. Draft one email per organisation

Each email names something true about **that** organisation. A mail merge with the name
swapped is what this skill exists to avoid — if the only difference between two drafts is
the salutation, you have not used the data you were given.

- **Lead with their own work**: "you've delivered two KMC rounds on Connect" beats "we are
  seeking experienced partners".
- **Say what the round asks and when it closes**, from the round's real fields.
- **One clear action**, pointing at the round's own `form_url`/`announcement_url` when it has
  one, and its `contact_email` for questions.
- **Short.** These go to people running delivery organisations.
- **No invented facts.** No claimed budget, no promised award, no "as we discussed".
- **The directory does not hold their EOI answers** — only that they applied. Do not
  characterise what an organisation said in its submission, and say so if the email would
  read as though you had.

**An organisation with no contact on file gets its section with the recipient left blank and
a one-line note saying the address is missing.** Never guess an address from a domain, and
never quietly drop the organisation — a silent omission is how somebody gets left out of a
round.

## 3. Deliver so that one click opens a real draft

**Where it goes.** `drive_create_doc_from_markdown` needs a `parentFolderId` on a Shared
Drive, and this is not an opportunity, so there is no run folder to resolve. ACE's Drive root
is `ACE_DRIVE_ROOT_FOLDER_ID` in **`.env.tpl`** at the repo root — read it from there with
`Read`. It is a folder id rather than a secret, which is why it is committed. Do not spend
calls on `printenv`: a caller turn does not carry it in the environment, and the real `.env`
is outside this session's readable paths.

Then find-or-create a `marketplace-outreach` folder there (`drive_create_folder` is
find-or-create) and put the doc in it, named for the round and the date. Do NOT reach for
`resolve_opp_path` — it resolves an opportunity's path and this has no opportunity — and do
NOT fall back to Claude Docs: the deliverable is a Doc in ACE's own Drive, where the rest of
ACE's artifacts live. Both were tried on the first live run, and both are dead ends that cost
the whole delivery.

Build the doc with [[gdoc-email-drafts]]: publish the markdown with a `@@EMAIL_<org-slug>@@`
anchor under each organisation's heading, then insert every organisation's email block in one
`docs_insert_email_blocks` call. The person hovers a block, clicks the Gmail icon in the margin,
and gets a Gmail draft with the recipient, subject and body filled in. Keep each email short:
these go to people running delivery organisations.

(An earlier version of this skill claimed that email blocks inserted through the API do not get
the Gmail icon, and used Gmail compose URLs instead. That was wrong. Blocks built this way do
open as drafts, as the operator observed on 2026-09-24.)

Structure the doc so it can be worked through top to bottom:

1. **A heading naming the round** and its deadline.
2. **One line of instruction**: hover an organisation's block and click the Gmail icon in the
   margin to get a draft.
3. **A section per organisation**, in the order the page listed them — that is the order on
   screen, and somebody working down the list will follow it. Its email block holds the
   recipient, subject and body.
4. **A closing section listing anything a human must resolve**: organisations with no
   contact, slugs the directory did not hold (`not_found` from `marketplace_orgs_get`), and
   any organisation you deliberately skipped, with the reason.

Then **reply with the doc's link and a two-line summary** — how many drafts, and how many
need a human's attention. Not the drafts themselves: they are in the doc.

## What ACE does not do here

- **Never send.** The Gmail icon is the send step and it belongs to a person. ACE has a
  send path (`skills/email-communicator`) and it is not for this: a round of outreach to
  partner organisations is not a message ACE should originate.
- **Never write to the directory.** `marketplace_orgs_get` and `marketplace_rounds_list`
  are read-only; the LLO Directory sheet is the source of truth and `marketplace_import`
  is how it moves.
- **Never widen the list.** Draft for the organisations that were on screen. If the person
  wants "everyone in the network", have them say so — and say how many that is first.

## Dependencies

None beyond ACE's own Drive tools. `docs_insert_email_blocks` is ACE's own atom, so this skill
adds no plugin to a runner's install list.

Related: [[email-communicator]] (ACE's own send path, deliberately not used here),
[[gdoc-email-drafts]] (how the blocks are built), `eva:gdoc-review` (worth a pass before a link is handed over).
