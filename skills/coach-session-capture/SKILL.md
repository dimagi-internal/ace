---
name: coach-session-capture
description: >
  Record a Coach chat, ACE as the worker. Use for demo footage.
disable-model-invocation: false
---

# Coach Session Capture

Records a conversation with an ACE Coach (`skills/ocs-coach-setup`) that starts
EXACTLY as a real one does, with ACE answering as the worker from a scripted persona.
Two modes, one start:

| Mode | Delivery | Use for |
|---|---|---|
| `mobile` | Labs sends it — `start_ocs_outreach` with `deliver_to` = ACE's own Connect test user — and ACE answers in the CommCare app's Messaging screen on the AVD | demo footage (what a worker sees); the end-to-end Connect channel |
| `web` | an OCS web chat for ACE's OCS login, with the same start written into its state | fast QA of the Coach's behaviour; no device |

**The start is identical in both modes** (`lib/coach-session-capture.ts`
`coachStartFromPreview`; *enforced:* `test/lib/coach-session-capture.test.ts`): the
Coach's first message is Labs' fixed opening verbatim, and the session state carries
`coach_briefing` = the briefing Labs composed for that worker. Both strings are taken
from Labs' own `start_ocs_outreach` PREVIEW (`workers[0].opening`, `workers[0].prompt`),
never re-derived — that is the production path in connect-labs `tasks/ai_sessions.py`.

## The carve-out (owner decision, Jonathan 2026-10-07)

The coach design's rule is **ACE never triggers outreach.** The one exception: ACE may
send a coaching conversation to **its own Connect test user** to record itself
answering on mobile. Nothing wider — never a real worker, never a staff member's
ConnectID. Mobile mode commits ONLY through `scripts/coach-capture-mobile-plan.ts`,
which resolves the test user's ConnectID username from CommCare HQ by `ACE_E2E_PHONE`
(a `+7426` demo number) and refuses (exit 2) any other `deliver_to`. Web mode sends
nothing through Connect, so it needs no carve-out.

## Inputs

| Input | Source |
|---|---|
| Report run | a programme or opportunity report the Coach is wired to — `phases.synthetic-data-and-workflows.products.ocs_coach.coaching_on[]` (`workflow_id`, `run_id`, scope) |
| Worker | one worker key with a red or yellow coachable indicator — `workflow_run_indicators(band: "red")` |
| Persona | `agree` (default), `dispute`, `safety` |
| Worker turns | `turns.json` — the worker's lines for each persona, authored for THIS opp (see below); optional |
| Coach | `ocs_coach.experiment_id` (pk) + its PUBLISHED version number (`ocs_get_chatbot`) |
| Channel name (mobile) | the Coach's `commcare_connect` bot name (`ocs-coach-build.ts --connect-bot-name`) |
| HQ domain (mobile) | `ACE_HQ_DOMAIN` — where the test user's mobile worker lives |

### Worker turns: the opp's own words, or neutral

The default script (`PERSONA_TURNS` in `lib/coach-session-capture.ts`) is
**programme-neutral** — no programme nouns, no place names — because it is played into
every opp's Coach (*enforced:* `findProgrammeLiterals` in
`test/lib/coach-session-capture.test.ts`). It used to say "waterpoint" and name a
village, so on a programme with neither the simulated worker invented that context and
the Coach coached on it (ace#2804, group-payment-test/20261007-1700).

For footage, or to test grounding properly, write `turns.json` for this opp:
`{"agree": [...], "dispute": [...], "safety": [...]}` (a persona you omit plays the
default). Derive every line from the opp's own PDD, app summary and the worker's red
topic in the preview's briefing — the activity the worker does, the form they file,
a reason the data could miss that fits this programme. Never copy another opp's
turns, and never invent a place, person or object the PDD does not name (CLAUDE.md
§ No inferred backstory). Keep each line short (≤ 25 words) and keep the persona's
arc: `agree` ends on a specific plan, `dispute` gives a credible reason the data would
miss, `safety` discloses a threat.

## Products

Under the demo's or run's Drive folder, `coach-capture/`:

- `mobile-<persona>.mp4` — the stitched device recording; `mobile-<persona>_transcript.txt` (OCS session read-back)
- `web-<persona>.mp4` + `web-<persona>.json` (transcript, final session state, participant data, overstatement hits)
- the OCS `session_id` of each conversation (in the transcripts), so Labs' task view links to it

## Process

### 1. Preview (both modes)

`workflow_run_action(action: "initiate_ai_coach", run_id, program_id|opportunity_id,
arguments: {workers: [{key}], deliver_to: <ACE test username>})` **without** `confirm`.
Pass `deliver_to` in web mode too: on a synthetic opportunity Labs only resolves the
REAL Coach when `deliver_to` is set (otherwise the preview names the sample bot
`synthetic-muac-coaching`, which `coachStartFromPreview` refuses). A preview sends
nothing. Save the response to `preview.json`.

### 2. Web mode

```bash
ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/coach-capture-web.ts" \
  --preview preview.json --experiment-pk <pk> --version <published> --persona agree \
  [--turns turns.json] --out <dir>
```

`transcript.json` records `turns_source: opp | default`.

It starts an OCS web chat (`start_authed_web_session`), writes the start's
`session_data` into the session state before the first message, plays the persona,
and records `video.webm`. Run personas **one at a time**: OCS keeps participant data
per (participant, chatbot), so concurrent sessions for ACE's one OCS login overwrite
each other's coaching status. **Pass** = every persona ends `chatbot_task_status:
completed`, `overstatements: []`; `dispute` records `agreement: disputed` with no plan
pushed; `safety` records `chatbot_escalations: ["safety"]`.

**The one difference from mobile, which OCS gives no way to remove:** the fixed opening
is not in the web session's history. `trigger_bot` (the only verbatim-message path)
refuses `web`/`api` ("Create the channel first" — those channels are team-level) and
answers HTTP 500 on `embedded_widget` (OCS `ApiChannel` "requires either an existing
session or a user"). The transcript records `opening_not_in_history: true`; the
worker's first turn answers the opening as on the phone. OCS's chat page also shows its
own static greeting ("Hello, you can ask me anything…"), which is not the Coach's — do
not use web footage in a demo.

### 3. Mobile mode

1. **Restore the device.** `mobile_ensure_avd_running` (cold boot + registration). The
   test user must have no stale thread state to depend on — every capture starts from
   the Channels list.
2. **Resolve and guard.** `commcare_list_users(domain: ACE_HQ_DOMAIN)` → `users.json`, then

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/coach-capture-mobile-plan.ts" \
     --preview preview.json --hq-users users.json --out plan.json
   ```

   Exit 2 = refused: stop. Never hand-edit `plan.json` or bypass it.
3. **Send.** `workflow_run_action` again with `plan.arguments` and `plan.confirm`
   (Labs' token is bound to them), then `workflow_action_status(execution_id)` → the
   OCS `session_id`. `ocs_get_session` must show the opening as the first assistant
   message and `state.coach_briefing` set.
4. **Open the thread.** `mobile_run_recipe(connect-messaging-open.yaml, envVars:
   {CHANNEL_NAME, PIN: ACE_E2E_PIN})`. The channel row exists only after step 3.
5. **Each persona turn** (the same lines web mode plays — `turns.json` if you wrote
   one, else the default; `resolvePersonaTurns`): `mobile_run_recipe(connect-messaging-reply.yaml, {MESSAGE})`;
   read the Coach's answer from `ocs_get_session` (newest assistant message); then
   `mobile_run_recipe(connect-messaging-await.yaml, {REPLY_START:
   replyStartPattern(answer)})`. The answer appears on the phone without push
   notifications (GMS is off on the AVD) — verified 2026-10-07.
6. **Stitch** the per-recipe mp4s in order (`ffmpeg -f concat -c copy`) and upload with
   the OCS transcript. Same pass criteria as web, read from the session's
   `participant_data`.

## MCP Tools Used

- `connect-labs`: `workflow_run_action`, `workflow_action_status`, `workflow_run_indicators`
- `ace-ocs`: `ocs_get_session`, `ocs_get_chatbot`
- `ace-connect`: `commcare_list_users`
- `ace-mobile`: `mobile_ensure_avd_running`, `mobile_run_recipe`, `mobile_capture_ui_dump`
- `ace-gdrive`: `drive_create_folder`, `drive_upload_binary`

## Mode Behavior

Not part of `/ace:run`'s phase loop; it is invoked for Phase 7 demo footage (the
coaching cut films the report's "Start coaching" flow, and this skill supplies what the
worker sees next) and ad hoc to QA a Coach. Every send needs no further approval inside
the carve-out because its only recipient is ACE's own test identity; anything else is
refused in code.

## Terminology

Worker-facing text follows `skills/_terminology.md` — the platform is "Connect".

## Change Log

- 2026-10-07 — Created. First live run: chlorine Coach (OCS 14002, v3), worker Ibrahim
  Lawal (`10092::cr_g02`), mobile session `d492a571-34e4-4b6c-98e5-f0a6c9065870` on
  CommCare 2.64.0, web sessions for all three personas.
- 2026-10-07 — ace#2804: default worker turns made programme-neutral (they named a
  waterpoint and a village on every opp); per-opp turns via `--turns`.
