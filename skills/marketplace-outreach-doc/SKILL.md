---
name: marketplace-outreach-doc
description: Draft one grounded outreach email per organisation for a marketplace EOI round, as a Doc of one-click-to-Gmail blocks. Use when asked for emails for the orgs on a marketplace page.
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

**An organisation with no contact on file gets a block with an empty `To:` and a one-line
note saying the address is missing.** Never guess an address from a domain, and never quietly
drop the organisation — a silent omission is how somebody gets left out of a round.

## 3. Deliver as real email blocks

Follow **`eva:email-macros`** for the mechanics — read that skill and do what it says. The
short version: a bolded `Subject:` line is *not* an email macro; the native `@email` building
block (To/Cc/Bcc/Subject/Body with a Gmail icon in the margin) is, and
chrome-sales' gdrive MCP has the tool that inserts one (its insert-email-block atom).

Structure the doc so it can be worked through top to bottom:

1. **A heading naming the round** and its deadline.
2. **One line of instruction**: click the Gmail icon on a block to open it as a draft.
3. **A block per organisation**, in the order the page listed them — that is the order on
   screen, and somebody working down the list will follow it.
4. **A closing section listing anything a human must resolve**: organisations with no
   contact, slugs the directory did not hold (`not_found` from `marketplace_orgs_get`), and
   any organisation you deliberately skipped, with the reason.

Then **reply with the doc's link and a two-line summary** — how many blocks, and how many
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

## Dependencies worth knowing

`chrome-sales` (for its insert-email-block tool) is declared in ACE's `config/agent.json`
`required_plugins`. Before it was declared, this skill worked only on a box that happened
to host Eva as well, which is the kind of dependency that fails on a fresh runner and looks
like a bug in the skill.

Related: [[email-communicator]] (ACE's own send path, deliberately not used here),
`eva:email-macros`, `eva:gdoc-review` (worth a pass before a link is handed over).
