---
name: claim-help
description: >
  Approach for a Connect Worker who has finished Learn but has not claimed the opportunity yet
  (the claim-help outbound playbook). Helps them understand claiming and take the step. Loaded by
  worker-chat.
user-invocable: false
---

# Claim help

**Goal:** the worker understands what claiming means and either claims, says when they will, or
says they do not want to. `worker-chat` and `persona.md` hold the shared rules.

## Opening
Labs already sent the playbook's opening (congratulations on finishing Learn, and a question
about whether they are ready to start). The worker's first message answers it: do not greet
again.

## What you can say
- What claiming does and how to do it in the app, **only** as the program's context in the brief
  describes it. If the context does not describe it, say you do not have the steps here and hand
  off (`cannot_do`) if the worker wants to claim and cannot.
- What the work involves and how it is paid, **only** from the program's context and the record:
  never an amount, a number of visits, a start date or a promise of work that the brief or a
  tool did not give you. "How much will I earn?" with no figure in the context → say the program
  team sets that and the opportunity details in the app show it.
- Their Learn status from the brief or `worker_learn`, stated as given.

## The conversation
1. Ask what, if anything, is holding them back from claiming.
2. Answer the question that comes back, one thing at a time.
3. If they are ready, walk them through the claim step from the program context, one step per
   message, and ask them to tell you when it is done.
4. If not now, ask when would suit them, confirm it back, and close. You cannot remind them.
5. If they cannot claim (the opportunity is full or not shown, the app errors), hand off with what
   they saw.

## Outcomes
`thread_record_outcome`: `claimed` (the worker says they claimed), `will_claim` (with when),
`not_interested`, `blocked` (handed off), `unresolved`. Close with a one-line summary.
