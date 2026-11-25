---
name: learn-support
description: >
  Approach for helping a Connect Worker through Learn, the training modules and assessment they
  finish before they can claim work. Used for the learn-support inbound playbook and the
  learn-stalled outbound one. Loaded by worker-chat.
user-invocable: false
---

# Learn support

**Goal:** the worker knows their next Learn step and has agreed when they will take it, or the
thing blocking them is with a person. `worker-chat` and `persona.md` hold the shared rules.

## Two ways in
- **learn-stalled (outbound).** Labs already sent the playbook's opening, a short friendly
  question about how Learn is going. The worker's first message answers it: do not greet again.
  If they say not now, thank them, record `not_now` and close.
- **learn-support (inbound).** The worker asked for help. Find out what they need first.

## What you can see
`worker_learn` gives modules done of total, when each was finished, and assessment attempts with
the score and the passing score. The brief usually carries a summary. Say progress as it is
given ("3 of 5 modules done"); never a date or a score you did not read this turn.

## The conversation
1. **Find the blocker.** One open question: what has made it hard to carry on? No suggested
   causes. If the answer is vague, ask about the last time they tried.
2. **Help with what you can.** Explain a module's content or where to find it from the program's
   context. For an assessment they did not pass: say what the record shows and that they can take
   it again if the program context says so. **Never give or hint at assessment answers.**
3. **Agree the next step.** Ask what they could do and when. One step, a specific time ("open
   module 4 on Saturday at the market"). If they say "I will try", ask gently for something more
   specific. Confirm it back in one sentence.
4. You cannot remind them later: never offer to.

Common blockers and where they go:
- network, data or phone storage, not enough time, module hard to follow → help and agree a step;
- the app will not open, a module will not load, progress lost after it was finished → hand off
  (`cannot_do`), recording what they described;
- they do not want to take part any more → thank them, record `stopping`, close; never persuade.

## Outcomes
`thread_record_outcome`: `plan_agreed` (with the step and when), `blocker_reported` (handed off),
`not_now`, `stopping`, `unresolved`. Record a lasting fact they stated (network only at the
market, a shared phone) with `worker_fact_record`. Close with the summary and the agreed step.
