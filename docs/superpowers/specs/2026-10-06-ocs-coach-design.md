# ACE Coach — an OCS coaching bot built per opp, triggered by a human from Labs

Status: v1 built (2026-10-06) — `skills/ocs-coach-setup`, `templates/ocs-coach/`,
`lib/coach-briefing.ts`, `scripts/render-coach-prompt.ts`, `scripts/ocs-coach-build.ts`.
First instance: spark-facilitator/20261004-1706, OCS experiment 13957, QA'd over the
API channel. **Blocked for real sends:** OCS team `connect-ace` lacks the
`flag_commcare_connect` feature flag, so the Coach has no Connect channel yet
(`Vaccine_Coach` has it). Not yet wired into the Phase 5/7 agents — run the skill
at the Phase 7 boundary. Owner decision recorded: **ACE never triggers outreach.**
ACE builds the Coach and wires the Labs workflow so that an operator, on the
right run page, can tell the canopy panel *"trigger all coaching sessions"* and
confirm a preview.

## 1. What we are copying — the real KMC Coach

Observed live 2026-10-06 via `ocs_inspect_chatbot` (team `Vaccine_Coach`).

| Bot | id | Role |
|---|---|---|
| **KMC Audit bot** (v8, published) | `56a2cf10-1378-4967-9ea0-49ca64ce6ab9` | The **Coach** — outbound, flag-driven coaching |
| KMC Q&A Bot for FLWs & Mothers (v54) | `a4ce4094-21a5-4564-85e0-f66059ed2da2` | Inbound RAG Q&A (what ACE Phase 5 already builds) |

**Coach structure** — deliberately small:

- Channels: `commcare_connect` (bot name "KMC Audit bot"), `web`, `api`.
- Pipeline: `Start → LLMResponseWithPrompt (claude-sonnet-4-6, history global/summarize) → CodeNode → End`.
  No collections, no custom actions, no static/timeout triggers.
- **Prompt = a coaching script.** The opening `prompt_text` carries a *Flag
  Indicators* list (`- Equip image [image_missing]`) — the bot's task list, worked
  top-to-bottom, one topic at a time: introduce → understand the reason (no vague
  answers, gently surface contradictions with data) → co-design a fix → agree a
  specific plan. Golden rules: one question per message, never reveal numbers or
  topic keys. Per-topic guidance (meaning, common reasons, key question, the
  expected behaviour to restate) for each key (`image_missing`, `rounded_weights`,
  `zero_danger`). Non-response: nudge every 48 h in-script.
- **Markers → structured state.** The LLM ends a topic's agreed-plan message with
  `[[KMC_TOPIC_DONE:<key>]]` and the final close with `[[KMC_DONE]]`. The
  CodeNode strips markers from the reply and writes participant data:
  - `chatbot_topics_done` — append-only list of finished keys (reset on a new session);
  - `chatbot_task_status` — monotonic `initiated → in_progress → completed`;
  - session state `cchq_user_id`, `domain`.

**Labs side** (connect-labs `origin/main` @ `aa1a862c`):

- `POST /api/trigger_bot` with `platform: "commcare_connect"`, `identifier` = the
  worker's ConnectID username, `experiment`, `prompt_text`, `start_new_session: true`,
  `session_data {task_id, opportunity_id, username, created_by}`
  (`connect_labs/tasks/ai_sessions.py`). Runs with the **person's own OCS OAuth token**
  (`UserOCSToken`), not a team key.
- No program→bot mapping exists; a bot is picked per call or declared per workflow in
  `config.actions[].defaults.bot`.
- Progress: `/labs/workflow/api/chatbot-status/` reads `chatbot_task_status` /
  `chatbot_topics_done`; the denominator is `task.data.coaching_indicators`.

### 1b. How the KMC Coach actually performs — transcript review (2026-10-06)

All 28 sessions on the KMC Audit bot, read in full: 13 real FLWs (one batch,
2026-09-23, all on `zero_danger`), the rest Dimagi staff tests. Of the 13, 7 reached
`completed`, 5 stalled mid-conversation, 1 never replied.

1. **It misstates the data — every time.** The briefing said a high share
   (bands: red > 75%) of visits had no danger sign. In **10 of 10** real
   conversations that reached the data step, the bot told the worker *no* danger
   sign had *ever* been recorded ("not even once", "every baby has been marked as
   having none") — 1–2 times per conversation, after the worker had disagreed. The
   one later test with a revised prompt (v8, "changed danger sign prompt") said "a
   very high number" correctly; that fix is untested at scale. Cause: the bot is
   told not to quote numbers (a simplicity choice for CHWs, not a hard rule — Jon,
   2026-10-06), has no permitted wording for the finding, and paraphrases a rate
   into an absolute. A false claim about someone's own work is
   the fastest way to lose them.
2. **Workers disagreed, and were usually right about why.** Nearly every worker
   said they do record danger signs, then — under good probing — described the
   same *system* causes: danger signs come **last** in the form, after weighing,
   so a severe sign means abandoning the form to refer; signs reported by phone
   between visits have nowhere to go; the visit can only be recorded at the
   mother's location; signs outside the main list go to an "other" free-text field
   (which the indicator may not count). Workers proposed concrete fixes (danger
   signs first; a "did you refer?" prompt; make the equipment photo mandatory).
   The bot then **pushed for a personal commitment anyway** — including to record
   before referring, which one worker called unethical — and "agreed" plans that
   were the worker's existing behaviour.
3. **Promises with no mechanism.** "I'll pass this on to the app team", "I'll check
   in Sunday evening", "send the screenshot in this chat" (attachments are off).
   None of these exist; v8 has no timeout triggers and no escalation path.
4. **Openings bypass the script.** Labs' `prompt_text` overrode the system prompt's
   opening: workers got "routine quality check of your audits" and a cold
   assessment question, then the bot re-introduced itself mid-conversation. One
   Runyankore-region worker got an opening in (garbled) Kinyarwanda.
5. **Earlier staff tests** sent notification-style reviews with raw numbers ("HR
   copy rate 8/10") and one written in the third person *about* the worker, *to*
   the worker — the briefing was echoed, not interpreted.
6. **Marker bookkeeping is unreliable:** `chatbot_topics_done` holds duplicates
   (`['zero_danger','zero_danger']`), and several `completed` sessions have no
   topic recorded at all.
7. **Form factor:** long, emoji-heavy, repetitive affirmations to workers typing on
   phones in the field ("typing is not easy", asked for voice notes).

What it does well: warm, patient, good at walking a worker through one concrete
visit, and it surfaced a real app-design defect in under an hour that a dashboard
alone never would.

### 1c. Why the opening went wrong — OCS's triggered message is not the bot

Found live 2026-10-07 (OCS session f931d8ea): OCS `trigger_bot` with `prompt_text`
does NOT run the chatbot's pipeline. `trigger_bot_message_task` →
`ExperimentSession.ad_hoc_bot_message` → `EventBot.get_user_message`
(apps/chat/bots.py) — a generic "write a reminder" LLM call with its own system
prompt. The Coach's script, knowledge base and status node never see the opening;
the briefing reached the worker nearly verbatim ("🔴 Step 7 on time — 0 out of 3 …
red band"). The KMC openings (§1b item 4) have the same cause. Only replies go
through the pipeline.

The fix: Labs sends a fixed greeting as `message_text` (verbatim, no LLM) and the
briefing as `session_data.coach_briefing`; the Coach prompt reads
`{session_state.coach_briefing}` and knows the greeting has been sent.

## 2. The trigger path (no new trigger machinery)

Everything below already exists in Labs (`connect_labs/workflow/actions.py`,
`docs/canopy-agent-panel.md`, `WORKFLOW_REFERENCE.md` §14):

1. Operator opens the opp's coaching workflow run page. The workflow has
   `config.agent.share: true`, so the canopy panel renders with the run's selection.
2. "Trigger all coaching sessions" → the agent reads flagged workers via
   `workflow_run_indicators`, then calls `workflow_run_action(key="initiate_ai_coach",
   workers=[{username, prompt, indicators}])`.
3. Labs returns a **preview + single-use confirm token**; the agent shows it; only the
   operator's yes produces the second (committing) call.
4. Labs' Celery executor creates one task per worker and starts the OCS session, as
   the operator.

The run page's own action button is the same code path, so the panel is a
convenience, not a dependency.

## 3. What ACE builds

### 3a. Coach golden template (one-time, `connect-ace`)

`ACE Coach Template` — the KMC Audit bot generalised:

- Markers renamed `[[COACH_TOPIC_DONE:<key>]]` / `[[COACH_DONE]]`; participant-data
  field names kept **identical** (`chatbot_task_status`, `chatbot_topics_done`) so
  Labs' existing status endpoint works unchanged.
- Prompt split into a fixed script and a `## Behavior-Specific Guidance` block that
  is the only per-opp part.
- Bootstrapped by a script alongside `scripts/bootstrap-ocs-golden-template.ts`;
  id stored as `OCS_COACH_TEMPLATE_ID`.

### 3b. Phase 5 — new skill `ocs-coach-setup` (+ `-qa` / `-eval`)

1. Clone the Coach template → `ACE Coach - <opp> (<run>)`.
2. **Topic list = the Phase 7 registry's flag indicators.** Topic keys MUST equal
   indicator ids, so a red indicator on the dashboard, the key in `prompt_text`, and
   the entry in `chatbot_topics_done` are one identifier. Phase 5 runs before Phase 7,
   so the keys are derived from the PDD's verification/quality section by a shared
   helper (`lib/coach-topics.ts`) that Phase 7's `semantic-registry-author` also
   consumes — one source, two readers. *Enforced:* a test that every coach topic key
   exists in the run's registry.
3. Write per-topic guidance from the PDD (meaning, likely reasons, key question,
   expected behaviour). No inferred backstory — guidance cites the PDD section.
4. Enable the `commcare_connect` channel (bot name = chatbot name); publish.
5. Write `phases.ocs-setup.products.coach = {public_id, experiment_id, team_slug,
   topic_keys[]}`.

`ocs-coach-qa` drives N simulated-worker conversations **over the `api` channel only**
(never `commcare_connect`, never a real identifier) using `ocs_trigger_bot_message` +
`ocs_send_test_message`, and checks structurally: every topic gets a marker, markers
never leak into replies, `[[COACH_DONE]]` only after all topics, no numbers revealed,
one question per message, `chatbot_task_status` reaches `completed`.
`ocs-coach-eval` judges tone, probing quality and plan specificity (LLM-as-judge,
uniform verdict shape).

### 3c. Phase 7 — wire the coaching workflow

On the reports Phase 7 already builds — the programme report and each partner's
opportunity report (`demo-data-setup` ace-run provider), never a separate copy
(Jon, 2026-10-06: coaching belongs in the core set the demo uses). Their render
already shows a declared action as a worker-row button:

```json
"config": {
  "agent": {"share": true},
  "actions": [{
    "key": "initiate_ai_coach",
    "type": "start_ocs_outreach",
    "label": "Start coaching",
    "defaults": {"bot": "<coach public_id>"}
  }]
}
```

…and a flag column exposing each worker's red indicator keys, so "all coaching
sessions" has a precise referent: every flagged worker in the current selection.
Phase 7 data is synthetic, so a dry run there sends nothing (Labs attaches a sample
transcript on synthetic opps) — a safe end-to-end demo of the panel flow.

### 3d. connect-labs change (filed against `dimagi-internal/connect-labs`)

`start_ocs_outreach` does not record `task.data.coaching_indicators`, so coaching
started through an action has no progress denominator. Add an optional per-worker
`indicators: string[]` to the action schema and store it on the task. Small,
additive; ACE's agent passes it from `workflow_run_indicators`.

## 4. Where it lives (default)

The Coach lives on **`connect-ace`**. Because Labs runs the action with the
operator's own OCS token, every operator who will trigger coaching must be a member
of `connect-ace` with OCS connected in Labs (`/labs/ocs/initiate/`).
`share-run-access` / `release` gain an OCS team-membership grant for the coach's team.

## 5. Open / to verify live before the first real send

- Connect channel enrolment is **not** an open question: messaging is part of
  PersonalID in the CommCare mobile client, and works as it does for KMC (Jon,
  2026-10-06).
- Bot id field: `trigger_bot` is called with `public_id or id` in the workflow path —
  confirm which the action's `defaults.bot` must carry.
- Session linking in Labs takes the newest of 5 sessions per experiment; concurrent
  bulk sends may mislink (Labs-side, note only).

## 5b. The coaching model: Audit & Feedback, via supportive supervision

The Coach is an **audit-and-feedback** intervention delivered as **supportive
supervision**. Each layer maps to an established method:

| Layer | Method | What it fixes from §1b |
|---|---|---|
| Overall intervention | Audit & Feedback (Cochrane, Ivers et al.: works best when repeated, from a supervisor-like source, with explicit targets and an action plan) | one-off chats → repeated cycles with a target |
| Stance | Supportive supervision (WHO CHW guideline, 2018): two-way, problem-solving, not punitive | pushing commitments on disputed findings |
| Is it a real problem? | Data-quality review logic (WHO DQR / RDQA): separate a *recording* problem from a *care* problem from a *measurement* problem | coaching workers on an indicator artefact |
| Why | Root cause by fishbone categories: people, process, tools, environment, **measurement** | reasons collapse to "worker should try harder" |
| Conversation | GROW (Goal, Reality, Options, Way forward) + Motivational Interviewing (open questions, reflections, summaries; no "righting reflex" under resistance) | the push after a worker says no |
| Over time | PDSA: the agreed plan is Plan; the next data window is Study; the follow-up session is Act | no follow-up; nothing checks whether the plan worked |

### The agreement gate (new Step 2b, per topic)

After introducing a topic, the Coach states the finding in **approved wording**
(§5c) and asks whether it matches the worker's experience. Three exits:

- **Agree** → root cause → plan (as today).
- **Disagree with an explanation** → explore one concrete visit, then classify:
  if the cause is *measurement* (indicator miscounts, e.g. "other" field ignored),
  *tools/process* (form order, location lock, no between-visit recording), or the
  worker credibly did the right thing, the Coach **does not seek a commitment**. It
  records the dispute and the worker's account, tells the worker plainly that
  their supervisor / the programme team will review it, and moves on.
  → `[[COACH_TOPIC:<key>|agreement=disputed|cause=<category>|owner=program|summary=<text>]]`,
  task status → Review needed, routed to the LLO and Dimagi.
- **Partially agree** → a plan only for the part the worker owns; the rest
  routed as above.

Only `owner=worker` topics produce a worker plan. `owner=program|app|data`
findings aggregate across workers on the dashboard — in the review above, ~10
workers independently named the same form-order defect; that is one app fix, not
ten coaching plans.

### 5c. What the Coach knows: a per-opp knowledge pack

The Coach needs enough about the app and the KPIs to reason, and **guard rails on
what it may assert**. ACE built both the app (Nova blueprint) and the indicator
registry, so it can generate, per opp:

- **Indicator cards** (from the Phase 7 registry): definition, numerator /
  denominator, what counts and what does not (e.g. whether the "other danger
  sign" field counts), bands, known confounders, and a **plain-language
  statement of the finding** a CHW can follow ("62 of your last 64 visits had no
  danger sign marked" or "most of your visits", never "none" / "every" / "not
  once" unless literally true). Numbers are allowed when they help; the rule is
  accuracy and simplicity — never strengthen a quantifier beyond the data.
- **Form-flow cards** (from the app summary): where the relevant questions sit,
  what is required, what is location-restricted, and how to record the thing in
  question — so "danger signs come last" is something the Coach already knows,
  and can respond to, instead of asking "how is your app set up?".
- **Per-worker briefing** from Labs: the count behind the band (e.g. 62/64), the
  band, and a few anchoring visits (dates) where available.
- **Not** in the pack: other workers' data, anything the worker's own dashboard
  would not show them.

`ocs-coach-qa` adds a quantifier-fidelity check: every assistant statement about
the worker's data is compared against the briefing; any absolute ("none",
"never", "every", "at all") on a non-absolute finding fails the run.

## 5d. Who the Coach is talking to

The Coach is NOT the Phase 5 Q&A bot. It is cloned from it only to inherit the model
and the knowledge collection; its prompt is replaced wholesale. The Q&A bot answers
supervisors, partner staff and reviewers; the Coach talks to one community worker on
a basic phone, often in a second language. The template therefore carries an explicit
"Who you are talking to" section — at most three short sentences (~40 words) per
message, everyday words, no programme vocabulary (indicator, band, verified, flag…),
numbers as "12 of your 20 weeks" — and tells the Coach the knowledge base is written
for supervisors, so it may use its facts but never its wording.

## 6. Improvements over the KMC Coach (v1 = items 1–5)

1. **Make the follow-ups real.** The KMC prompt promises nudges at 48/96 h and
   "I'll check in again", but v8 has `timeout_triggers: []` — a bot only speaks
   when spoken to, so nothing fires. Add a 48 h inactivity `TimeoutTrigger` (max 2
   nudges) to the template, and don't promise a check-in the system won't make.
2. **Record the plan, not just "done".** Extend the marker to
   `[[COACH_TOPIC_DONE:<key>|reason=<category>|plan=<text>|by=<date>]]`; the CodeNode
   appends `chatbot_plans[{key, reason, plan, by}]` to participant data. The next
   coaching session's `prompt_text` carries the prior plan, so coaching is
   longitudinal ("last time you said you'd charge your phone before visits — how
   did that go?").
3. **Root-cause taxonomy → program signal.** `reason` is one of a fixed set
   (`knowledge`, `equipment`, `connectivity`, `app_issue`, `workload`,
   `process_unclear`, `other`). Aggregated across workers it tells the LLO/ACE when
   a flag is systemic (e.g. most `image_missing` = connectivity → fix the app or
   the protocol, not the workers). Feeds `flw-data-review`.
4. **Escalate instead of coaching through it.** `[[COACH_ESCALATE:<category>]]`
   for safety (a child at risk), a credible app/system defect, or distress; the
   CodeNode sets `chatbot_task_status: needs_review` and the bot stops probing.
   KMC has no exit for these.
5. **Grounded teaching + the worker's language.** Attach the opp's training
   collection (the one Phase 5/6 already build) so "can you name the danger signs?"
   corrects from the actual training material, not an inline list; respond in the
   worker's language (PDD languages).
6. **Richer briefing (Labs change, later).** Labs sends only `prompt_text`. Passing
   per-topic evidence (which visits, when) lets the bot anchor "walk me through one
   visit" on a real visit.
7. **Did coaching work?** After a session completes, compare the worker's flag
   rate in the following weeks against before; show "flag cleared after coaching"
   on the dashboard. That is the Coach's own outcome metric.

**Eval, which KMC lacks:** `ocs-coach-qa` simulates worker personas — cooperative,
vague, defensive, contradicts the data, wants to stop, real app bug, safety
disclosure — and `-eval` checks the right outcome for each (plan / no premature
done / escalation). In production, `ocs-chatbot-eval --monitor` grades sampled
real transcripts.

## 7. Not in scope

- ACE sending, scheduling, or re-triggering coaching (operator decision 2026-10-06).
- WhatsApp channel; mother-facing bots; the Q&A bot (unchanged).
