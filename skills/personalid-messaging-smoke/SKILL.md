---
name: personalid-messaging-smoke
description: >
  Check labs Messaging end to end on ACE's test phone: send, see the agent's answer arrive, time each hop.
  Use after a messaging or canopy change, or when worker replies go unanswered.
disable-model-invocation: false
---

# PersonalID Messaging Smoke

Proves one full round trip of labs Messaging over PersonalID, from a real phone, and says how
long each hop took: the test worker sends from the CommCare app, connect-id relays it to labs,
labs hands it to the playbook's answerer (a canopy agent such as `connect-helper`), the answer
goes back through labs and connect-id, and the app decrypts and shows it. A pass is the agent's
text on the phone's screen, not a `sent` status in labs.

It sends only as **ACE's own test worker** and only into a conversation that worker already has
(or one a person approved opening, step 3). It never messages a real Connect Worker. Rules it
follows: [`_verify-before-send.md`](../_verify-before-send.md) and
[`_terminology.md`](../_terminology.md) (the report says "Connect").

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the Connect program whose playbook answers | explicit arg (the synthetic smoke program used so far is 10236) |
| `playbook` | the playbook the conversation runs under; its handler is who answers | explicit arg; default `smoke-test` |
| `worker` | the test worker's PersonalID username | default: the slot `mobile_ensure_avd_running` checked out from the test-worker pool (`skills/test-worker-pool`) |
| `channel_name` | the channel row the app shows (the program's name as labs sends it) | explicit arg; default: read from the opening's footer ("Messages here come from <name> through Connect") |
| `message` | what the worker sends | explicit arg; default: "Smoke test from the ACE test worker at <UTC time>. What can you help me with?" |
| `thread_id` | the open labs conversation | default: `messaging_thread_list` for `program_id` + `worker`, state `open` |

No run is needed; it runs on any program with a playbook that names the test worker. **An
agent-answered playbook must grant the worker tools** (`tools`, the list
`skills/messaging-playbook-setup` gives): labs serves the agent only those, so a playbook without
them leaves it unable to read the record (failure class D). A conversation keeps the playbook
version it opened with, so after adding `tools` close the open conversation and start a new one.

## Products

- A report in the conversation (or on the board task that asked for it): pass or which failure
  class, the per-hop timestamps, and the paths of the screenshots and recordings.
- Device artifacts under the `screenshotDir` passed to `mobile_run_recipe`: the thread before
  sending, after sending, and with the answer on screen, plus each recipe's mp4.

## Process

1. **Get the device and the test worker.** `mobile_ensure_avd_running` (it cold-boots, installs the
   APK and signs in a pool worker). Use APK **2.66 or later**: older builds sent the key fetch
   to an http `key_url`, which the load balancer redirected, so the POST became a GET and labs
   answered 405.
   - `mobile_diagnose` names the held worker slot and warns when other sessions share the AVDs;
     a device that vanishes mid-run is most likely a peer's cold boot, not this skill's fault.
2. **Find the conversation.** `messaging_thread_list` / `messaging_thread_get` for
   `program_id` and `worker`. Note its `handler`, its newest message id, and whether a person has
   taken it over (`taken_over_by` set: the agent will not answer; report that and stop).
3. **If there is no open conversation, open one only with a person's yes.**
   `messaging_start({program_id, playbook, workers: [worker]})` without `confirm` returns the
   preview; show it, and send it with `confirm` only on their yes. Labs refuses a new opening
   while ANY conversation with that worker is open ("a conversation is already open"), so a
   fresh opening needs the old one closed in the labs Inbox first.
4. **Open the thread on the phone.** `mobile_run_recipe(connect-messaging-open.yaml,
   envVars: {CHANNEL_NAME: channel_name})`. Leave `PIN` out: the resolver fills it from the
   held worker. A caller value always wins, so passing a placeholder string (e.g. the literal
   text `${ACE_E2E_PIN}`) types that string into "Unlock PersonalID" and the run stalls there.
   - When the channel row is missing, the opening never reached this device (an opening sent
     before the device was wiped and re-registered is not re-delivered). Report it; do not wait.
5. **Send the message and record the time.** `mobile_run_recipe(connect-messaging-reply.yaml,
   envVars: {MESSAGE: message})`; the recipe's `messaging-sent` screenshot time is **t0**.
   Never send `STOP` or the program's stop words: that ends the conversation and turns this
   worker's messaging off.
6. **Wait for the inbound in labs.** Poll `messaging_thread_get` until a message with
   `direction: in` and this text appears; its `at` is **t1**. None within 60 s is failure
   class **A**.
7. **Wait for the answer in labs.** Keep polling until a newer `direction: out` message with
   `author_kind: agent` (or `flow`) appears; its `at` is **t2** and its `text` is the answer.
   None within 3 minutes, or the thread flips to `needs_attention`, is failure class **B**.
8. **Confirm the answer on the phone.** `mobile_run_recipe(connect-messaging-await.yaml,
   envVars: {REPLY_START: replyStartPattern(answer)})` (`lib/coach-session-capture.ts`). The
   recipe waits on the bubble whose text starts with the answer, which proves THIS answer is on
   screen; its `messaging-reply` screenshot time is **t3**. Also read the screenshot's ui dump
   (`uiDumpPath`) and check a `tvChatMessage` node carries the answer. The app shows it without
   a push notification (GMS is off on the AVD). Not visible within 90 s is failure class **C**.
9. **Report.** Pass, or the failure class with what was observed, plus the hops:

   | Hop | From → to | Seconds |
   |---|---|---|
   | phone → labs | t0 → t1 | connect-id delivery |
   | labs → answer stored | t1 → t2 | labs → canopy → runner → session → model → reply post |
   | labs → phone | t2 → t3 | connect-id → app fetch and decrypt |

   When the answering session's transcript is readable on this machine (a laptop runner), split
   t1 → t2 into plumbing and model: the prompt's arrival and the first assistant text in that
   session's `.jsonl`. Measured 2026-11-25 on a warm `connect-helper` session: 31 s from t1 to
   t2, of which the model took about 2 s.

### Failure classes

- **A. The inbound never reaches labs.** The phone shows the message as sent but labs has no
  `in` message: connect-id's signed delivery post to `/messaging/personalid/delivery/` was not
  made or was refused (HMAC secret, channel not registered). Read labs' web logs for
  `/messaging/personalid/` (`canopy aws request --role labs-read`, then `--profile labs-read`).
- **B. Labs has the inbound but no answer.** The canopy turn did not produce text. Known cause:
  the answering session never started because Claude Code held it on a startup dialog (the
  pre-approved-permissions trust check), and the turn ended empty, which labs drops silently.
  Fixed in dimagi-internal/canopy-web#2953, which also makes such a turn fail so labs flags the
  thread for a person. Check the playbook is enabled, the handler, `needs_attention` and
  `attention_reason`, then the canopy turn.
- **D. The answer says it cannot see the worker's record.** Read the canopy session (the agent's
  admins can, read-only): if `site_tools` answered `"tools": []`, the conversation's playbook
  version grants no `tools`. Fix the playbook, close the conversation, open a new one. Seen on
  2026-11-26 (`smoke-test` v1, threads 7 and 8).
- **E. The answer is sent but the phone only shows it when the thread is reopened.** No push: Play
  services is off on the emulator (registration turns it off for face capture). `adb shell pm
  enable com.google.android.gms`; ace ≥ the release with PR #3465 turns it back on itself.
- **C. The answer is in labs but not on the phone.** Labs stored and sent it, the app did not show
  it: the key fetch or decryption failed. Historically an http `key_url` became a 301, okhttp
  re-sent the POST as a GET and labs' POST-only `/messaging/personalid/key/` answered 405, fixed
  by https URLs in connect-id's MessageServer config. Check the phone's key fetch in the load
  balancer logs (POST, 200).

## MCP Tools Used

- Connect Labs: `messaging_thread_list`, `messaging_thread_get`, `messaging_start` (only with a
  person's yes), `messaging_playbook_get`.
- ace-mobile: `mobile_ensure_avd_running`, `mobile_diagnose`, `mobile_run_recipe` with the
  palette recipes `connect-messaging-open.yaml`, `connect-messaging-reply.yaml`,
  `connect-messaging-await.yaml` (selectors `messaging-*` in the selector map, live-verified on
  2.64.0 and the same resource ids passed on 2.66 on 2026-11-25).

## Mode Behavior

- **Auto:** runs every step except opening a new conversation, which always waits for a person's
  yes (step 3); sends only within the test worker's existing conversation.
- **Review:** the same, and shows the message before the phone sends it.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-11-25 | Initial version, from the first passing end-to-end run (labs thread 7, program 10236, `connect-helper`): per-hop timing, failure classes A/B/C, the PIN, open-conversation and STOP gotchas. | ACE |
