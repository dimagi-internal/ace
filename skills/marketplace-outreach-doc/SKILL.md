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

**An organisation with no contact on file gets its section with the recipient left blank and
a one-line note saying the address is missing.** Never guess an address from a domain, and
never quietly drop the organisation — a silent omission is how somebody gets left out of a
round.

## 3. Deliver so that one click opens a real draft

Build the doc with ACE's own Drive tools — `drive_create_doc_from_markdown` for the body,
then `docs_batch_update` to turn each "Open in Gmail" line into a link. Give each
organisation a **Gmail compose URL**:

```
https://mail.google.com/mail/?view=cm&fs=1&to=<email>&su=<subject>&body=<body>
```

URL-encode each field. One click opens Gmail's compose window with the recipient, subject
and body already in it — which is the thing being asked for. Keep the emails short: the
whole draft rides in a URL, and a few thousand characters is the practical ceiling.

**Do not reach for `docs_insert_email_block` (chrome-sales) instead.** It is the obvious
candidate and it does not do this. It inserts a **styled 5×2 table that imitates** the
native `@email` building block — its own description says "matching the native @email
building block", and its code comments say the styling constants were copied from one. The
Docs API has no request that inserts a building block, so a lookalike is all it can be, and
a table has no Gmail icon in the margin: clicking it does nothing. Delivering that under the
words "click the Gmail icon" is the exact failure `eva:email-macros` warns about — a thing
that looks like a macro and does nothing — one level up. It would also drag in a service
account that must be granted writer on every doc, a font-inheritance trap, and reverse-order
index arithmetic, for a worse result.

(If genuine native blocks are ever wanted, the one path that yields them is a template Doc
with real `@email` blocks in it, copied per use — smart chips survive a copy. That needs a
human-made template and a fixed block count, so it is not the default here.)

Structure the doc so it can be worked through top to bottom:

1. **A heading naming the round** and its deadline.
2. **One line of instruction**: click an organisation's "Open in Gmail" link to get a draft.
3. **A section per organisation**, in the order the page listed them — that is the order on
   screen, and somebody working down the list will follow it. Show the recipient, the
   subject and the body as text too, so the doc can be read and edited on its own.
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

None beyond ACE's own Drive tools. `docs_batch_update` executes raw Docs API requests, so
the links need nothing from another plugin — which is the point: this skill adds no plugin
to a runner's install list, and cannot fail because a box happens not to host another agent.

Related: [[email-communicator]] (ACE's own send path, deliberately not used here),
`eva:email-macros` (the same problem, solved with the imitation table — read the note in §3
before copying it), `eva:gdoc-review` (worth a pass before a link is handed over).
