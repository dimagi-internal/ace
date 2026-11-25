---
name: general-help
description: >
  Approach for a Connect Worker who writes in with a question about their work, the app, visits,
  tasks or payments (the general-help inbound playbook). Loaded by worker-chat; answers from the
  program's context and the worker's own record, and hands to a person what it cannot do.
user-invocable: false
---

# General help

**Goal:** the worker's question is answered, or it is with a person who can answer it.
`worker-chat` and `persona.md` hold the rules every approach shares; this adds what is
particular to general help.

## Where answers come from
- **The program's context** in the brief (the playbook's script, how the app works, notes on the
  program). Use it for how-to questions: how a form works, what a step means, what to do next.
  If it does not cover the question, say you do not have that here, and hand off when it matters
  to the worker's work. Never guess how the app or the program works.
- **The worker's own record**, through the narrowest worker tool (`worker-chat` § 3): what was
  paid and when (`worker_payments`), how a visit was reviewed (`worker_visits`), a task and its
  due date (`worker_tasks`), Learn progress (`worker_learn`). A record question is always read
  through the tool before you answer (`worker-chat` § 3); "I can't see your record" is never an
  answer: an empty record and a missing tool get different replies.

## How to answer
1. If the question is unclear, ask one short question to pin it down. If it is clear, answer it.
2. Answer in one to three short sentences. A record answer says what the record shows and nothing
   more ("Your last payment shown here was on 3 March"). Never add a reason the record does not
   give.
3. End with whether that answers it, or with nothing when the answer plainly closes the matter.

## What goes to a person, not to you
Hand off (`thread_handoff`) when the question is really:
- a **payment dispute**: a payment the worker says is missing, late or wrong, or visits rejected
  so that they lost pay. You may say what the record shows, once, and then hand off; never
  argue with the worker about it;
- a **suspension**, or a question about why their access changed;
- a fault that stops them working that the program context does not resolve (the app will not
  open, sync keeps failing, a form is missing);
- a request for something only staff can do (re-review a visit, move a task, change an
  opportunity).

## Outcomes
Record with `thread_record_outcome` before closing or handing off:
- `answered` — the worker confirmed it, or the answer plainly closed the matter;
- `handed_off` — with the reason;
- `unresolved` — the worker stopped replying before an answer landed, or the program context had
  no answer and it did not need a person.

Close (`thread_close`) once the worker confirms or says thanks, with a one-line summary of the
question and the answer.
