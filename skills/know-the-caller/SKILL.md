---
name: know-the-caller
description: Remember who is asking and resolve which coach, app or report they mean. Every turn with a person.
# Read inline from CLAUDE.md at the start and end of every turn with a person, never
# dispatched, so it stays out of the dispatchable catalog's character budget.
disable-model-invocation: true
---

# Know the caller

Every question is asked from somewhere: a program, a team, a thing someone already has open.
ACE has to answer from inside that context, not about Connect in general. This skill does two
jobs. It keeps a memory of each person in Drive, and it uses that memory to work out what they
are actually asking about.

**Origin (Jon, 2026-10-07).** Lilianna Bagnoli, who leads the Kangaroo Care (KC) metrics work,
asked what a worker sees when "AI coaching" starts for two flags at once. ACE answered for the
generic Coach that `/ace:run` builds, as if that were *the* coach. It isn't. There is no single
AI coach in Connect Labs, just as there is no single Connect app. What a worker sees depends on
the instructions and design of the coach that was triggered. Lilianna was almost certainly asking
about KC, and KC can have more than one coach. The right first move was to find out which coach
she meant, or to answer for each candidate and say it depends.

## 1. Start of the turn: load the person

1. **Who.** canopy's caller envelope (`who_is_asking`, or the `--caller` file) gives the name,
   email, relationship (owner, member, caller) and channel. A turn with no person in it (cron,
   board drain) skips this skill.
2. **Their doc.** `bin/ace-person read <email>`. Exit 1 means first contact: carry on, and
   start the doc in step 4.
3. **Their projects, live.** For each project the doc names, read the board project
   (`canopy agent projects --slug ace --active`) and its context doc (for a program, the
   `partner-on-connect-program` context doc). The person doc points to these. It does not copy
   them, so it can't go stale.

## 2. Resolve what they are asking about

**There is no "the" in Connect.** Apps, opportunities, coaches and other OCS bots, Labs
reports and workflows, indicator registries, cohorts and programs are all per-program content.
Each program has its own, and often several of each. When a question names a *kind* of thing
("the AI coach", "the app", "the report", "the dashboard") instead of a specific one, and the
answer depends on how that thing is built, resolve it before answering:

1. **List the candidates from their context.** Use the person's projects and their context
   docs. For example: Lilianna → Kangaroo Care → the KC coaches and bots in the context doc's
   *AI coaches and bots* row.
2. **One candidate:** answer for it, and name it in the first line ("For the KC Audit bot,
   …"). Read its live definition (prompt, pipeline, Labs action), not ACE's generic template.
3. **Several, or none known:** don't pick one silently. Do one of these:
   - **Ask one clarifying question** that names the candidates ("Which coach do you mean: the
     KC Audit bot, or another one?"). Do this when the answers differ and a wrong guess would
     mislead.
   - **Answer per candidate**, opening with what the answer depends on ("It depends on the
     coach's instructions. Here is how each KC coach behaves…"). Do this when the parts that
     differ are few and you can state them.
4. **A generic answer is labelled as one.** If you explain how ACE's own template or a
   platform default works, say so, and say what a specific program's version might change.
   Never present one design as how Connect works.
5. **Unknown instance.** If their project's context doc doesn't list the thing they mean, ask
   for its name or link. Then record it in that context doc (step 4), so the next person
   doesn't hit the same gap.

## 3. Read how they work with ACE

Use the doc's *How they work with ACE* section to shape the answer: the channel they use
(a Slack thread shows the whole session; email shows only the output), how technical they are,
what they already know, and what they asked last time. A follow-up builds on the earlier
answer instead of starting over.

## 4. End of the turn: write back

Update their doc with `bin/ace-person write <email> --name "<Name>" --md <file>`. It creates
the doc under `Process State/People/` on first contact and replaces it in place after that
(same link). Read the current doc first and keep everything still true. Then:

- Add one line to the **Conversation log**: date, channel, what they asked, which instance it
  turned out to be about, and the outcome. Include any correction someone made to ACE's answer.
- Update **Projects** and **Things they work with** when the turn showed something new: a
  project, a role in it, or an instance with its ID.
- Update **How they work with ACE** only from what happened in the turn.
- If the turn resolved an instance their program's context doc lacked, add it there (pointer
  and ID) as well. The context doc is shared by everyone on the program. The person doc is
  about one person.

Write in the third person, with facts from the conversation and its sources only. Follow the
no-inferred-backstory rule: never guess at someone's role, opinions or relationships.

## The doc

Title `<Name> <email>`, in ACE's Drive at `Process State/People/`, never shared (`--share none`).
Template:

```markdown
# <Name>

<email> · last updated <YYYY-MM-DD>

## Who they are
Role, team, organisation, each with its source ("said so in Slack, 2026-10-07").

## Projects with ACE
- <Board project name> (P<n>), context doc <link>: their part in it.

## Things they work with
The specific instances they have referred to, with IDs: registries, reports, apps,
opportunities, coaches and bots.

## How they work with ACE
Channels, technical depth, preferences, and recurring kinds of question.

## Open threads
Questions or asks still open, each with its date.

## Conversation log
- YYYY-MM-DD · <channel> · <what they asked> → <which instance> · <outcome>
```

## Boundaries

- **What goes in.** Work context only: roles, projects, the instances they use, how they like
  to work with ACE. Nothing personal. Nothing about another person beyond their role on a shared
  project. A caller's own words go in summarised, never as a transcript.
- **Who reads it.** ACE and its owner. A person doc never goes into a reply, a deliverable or
  another person's turn, and is never shared out of Drive. "What do you know about me?" is
  answered in the person's own turn, from their own doc.
- **The confined `/ace:ask` path** can't read Drive. There, canopy's envelope
  (`contact.notes`) is the memory, as `skills/answer-caller` says.
- **Approval.** Writing the person doc is ACE's own bookkeeping, not an outbound act, so it
  needs no approval in a manual-mode turn. Sharing it would need approval.

## Related

- `skills/partner-on-connect-program`: the program context doc, which lists each program's
  instances, including its coaches and bots.
- `skills/inbox-triage`: the email turn, where this skill is loaded per thread.
- `skills/explain-ace`: questions about how ACE itself works.
