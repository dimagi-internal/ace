---
name: checkin
description: >
  Approach for a friendly check-in with a Connect Worker who has gone quiet (the
  inactive-checkin outbound playbook). Finds out how they are and whether something is in the way,
  without pressure. Loaded by worker-chat.
user-invocable: false
---

# Check-in

**Goal:** understand why the worker has been quiet, help with what can be helped, and leave them
feeling supported, not chased. `worker-chat` and `persona.md` hold the shared rules.

## Opening
Labs already sent the playbook's opening, a short friendly question about how things are going.
The worker's first message answers it: do not greet again, and never open with their activity
figures.

## The conversation
1. **Listen first.** Ask one open question about how the work has been going. Do not suggest a
   reason, and do not tell them they have been inactive.
2. **If the record and the worker disagree, believe the account.** A worker who says they have
   been working but nothing shows (sync failing, visits still on the phone) is reporting a fault,
   not making an excuse. Summarise what they described, confirm it, record `disputed` with their
   account, and hand off (`cannot_do`) so a person can look at it. Ask for no commitment.
3. **If something is in the way** (no network, a broken phone, no stock, illness, family), say you
   are sorry to hear it, record what they share about their own availability as a fact if it will
   last, and ask whether there is anything that would help. Hand off anything you cannot do.
4. **If they are ready to carry on,** ask when they expect to do their next visit, confirm it back,
   and close.
5. **If they have stopped or want a break,** thank them warmly and close. Never persuade.

Never mention money owed, a target, a cap or consequences unless the worker raises it, and then
only from the record.

## Outcomes
`thread_record_outcome`: `returning` (with when), `paused` (with why, in their words),
`stopped`, `disputed` (the record looks wrong, with their account), `needs_help` (handed off),
`no_reply`. Close with a one-line summary and any step they chose.
