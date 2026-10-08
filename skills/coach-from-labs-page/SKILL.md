---
name: coach-from-labs-page
description: >
  On a Labs run page, show a worker's coaching picture, then send it on the person's click. Use in the canopy panel.
disable-model-invocation: false
---

# Coach From a Labs Page

A person in the canopy panel beside a Labs workflow run wants to coach one worker.
ACE shows them what would go out (the picture, the opening, the topics), lets them
change it, and sends ONLY when they press a button. The send is theirs: the Labs tool
runs as them, with their access, and Labs refuses anything they could not do from the
page's own "Start coaching" button.

## When this applies

- The session's page state is a Labs run: `resource` starts with `labs-workflow://`
  (read it with the page-state tool; `filters` carries `run_id` and the scope,
  `opportunity_id` or `program_id`).
- The person asks to coach a worker, to see the coaching picture, or to send a
  coaching conversation.

## The rule this narrows

The coach design's rule is **ACE never triggers outreach**
(`docs/superpowers/specs/2026-10-06-ocs-coach-design.md`), with one carve-out for ACE's
own test user (`skills/coach-session-capture`). This skill is a second, narrow one
(owner request, Jonathan 2026-10-08): **a person's own click, in this session, for one
worker.** ACE never chooses to send, never sends without a button press (or the
numbered reply below) from the person in this conversation, and never sends to more
than the one worker they saw previewed.

## Steps

1. **Find the action.** `workflow_run_context` for the run lists its actions; use the
   one of type `start_ocs_outreach` (usually `initiate_ai_coach`). No such action → say
   the workflow has no coaching action and stop.
2. **Pick the worker** from what the person named, else from the page's visible
   workers; `workflow_run_indicators` (band red / yellow) shows who has something to
   coach. One worker.
3. **Preview with the picture.** `workflow_run_action` without `confirm`:
   `{"workers": [{"key": "<opp>::<username>"}], "include_image": true}`. Settle any
   `needs` first: a bot (ask which of `bot_choices`), or an Open Chat Studio
   connection (give the person the preview's connect link).
4. **Show it.** From `workers[0]`:
   - the picture, as markdown: `![<image.caption>](<image.url>)`. The link opens for a
     person signed in to Labs who can see that opportunity (connect-labs#2338); if it
     shows broken, they need to sign in to Labs in this browser.
   - the `opening` (the worker's first message, verbatim) and the `briefing` topics;
   - the bot's name.
   - If the preview says `synthetic: true`, say plainly: sending to the worker attaches
     a demo conversation to their task and **no message is sent**
     (`tasks/ai_sessions.py`); only the QA option reaches a phone.
5. **Iterate.** Another worker, or another bot → preview again and show again. The
   picture always shows exactly the briefing's topics (Labs builds both from one
   briefing), so a different picture means a different worker or different red topics
   on the run, never an edited image.
6. **Ask with buttons.** `AskUserQuestion`, one question, options:
   - `Send to <worker first name>`
   - `Send to QA user` (description: the conversation goes to YOUR Connect app, on
     the worker's behalf)
   - `Not yet`
7. **On the click:**
   - **Worker:** call `workflow_run_action` again with the preview's `arguments` and
     its `confirm`.
   - **QA user:** you need the person's own ConnectID username. Use the one they gave
     in this conversation, else ask for it (`AskUserQuestion` "Other", or a plain
     question). Then preview again with `"deliver_to": "<username>"` added, and
     confirm THAT preview's token. Labs refuses `deliver_to` unless the person is
     Dimagi staff, and allows it for one worker only. The preview's `sending_to`
     line names the recipient; repeat it in your reply.
   - **Not yet:** stop. Send nothing.
   A `confirm` token expires after 15 minutes and is bound to exactly what was
   previewed. If it has lapsed, preview again and ask again; never reuse the old answer.
8. **Report.** `workflow_action_status` for the execution id: say who it went to, the
   OCS session id (or "demo conversation attached" for synthetic), and any per-worker
   error verbatim.

## No buttons (headless runner)

`AskUserQuestion` shows as buttons only when the panel's turn runs on an interactive
runner. On a headless one, end the turn with the same choices numbered (`1` send to the
worker, `2` send to the QA user, `3` not yet) and act on the person's reply next turn.
Preview again first, because the token will usually have expired.

## Not this skill

- ACE recording itself answering a Coach: `skills/coach-session-capture`.
- Building or changing the Coach bot: `skills/ocs-coach-setup`.
