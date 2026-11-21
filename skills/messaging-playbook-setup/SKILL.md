---
name: messaging-playbook-setup
description: >
  Author a program's labs Messaging playbooks: which Connect Workers each conversation is for,
  its opening, and the connect-helper / connect-coach skill or flow that answers. Dry-runs first.
disable-model-invocation: false
---

# Messaging Playbook Setup

Writes a program's **labs Messaging playbooks**: the rules by which Connect Labs talks with the
program's Connect Workers over PersonalID. A playbook says who a conversation is for, what
starts it, the opening sent word for word, who answers (a canopy agent with a skill, a labs flow,
a person, or nobody), how sends are approved, the caps, and the program context the answering
agent reads. The agents are `connect-helper` (inbound support, Learn, claim help, check-ins) and
`connect-coach` (coaching a supervisor starts, and its follow-ups); each runs one skill per
approach. Labs is the system of record and relays every message; nothing here sends one.

This replaces an OCS bot for a program that moves to labs Messaging. Building the playbooks
does not start a conversation: a person starts each outbound one from labs (`messaging_start`
previews and needs their yes), or an automatic trigger a named person approved does.

Rules this skill follows: [`_acting-as-you.md`](../_acting-as-you.md) (whose account each labs
write is as), [`_terminology.md`](../_terminology.md) (openings and context say "Connect"), and
[`_verify-before-send.md`](../_verify-before-send.md) (every opening reaches a worker's phone).

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the Connect program whose playbooks these are | explicit arg; default: program context doc § Scope; in a run, `opp.yaml` `connect.program.connect_int_id` |
| `approaches[]` | which starter approaches to write (§ The starter approaches) | explicit arg; default: all whose handler exists for this program |
| `script` | the program's coaching or support script the agents follow | explicit arg (Drive id / local file); default: program context doc § Living docs; in a run, the PDD's FLW-facing sections |
| `app_summary` | 5-8 bullets on how the Learn and Deliver apps work | explicit arg; default: `3-commcare/pdd-to-deliver-app_summary.md` (run) or program context doc § Apps |
| `persona_notes` | the program's own words and limits (what workers are called, languages, what support exists) | explicit arg; default: program context doc § Names + § People |
| `approver` | the named person who approved sending without a click (needed by any automatic trigger) | explicit arg; default: program context doc § Decisions. None found → no automatic triggers |
| `run_id` | run-bound mode: write-back to `run_state.yaml` | optional; absent = live-program mode (record in the program context doc) |

## Products

- labs Settings, namespace `messaging.playbooks`, program layer: one playbook per approach,
  versioned by labs (`messaging_playbook_set`).
- Live-program mode: the program context doc § AI coaches and bots gains a **Messaging** entry
  (program id, each playbook key@version, handler, trigger, approval, `approved_by`) and
  § Decisions a dated line naming who approved it.
- Run-bound mode: `run_state.yaml` `phases.execution-management.products.messaging_playbooks`:
  `{program_id, written_as, playbooks: [{key, version, direction, handler, trigger, approval,
  enabled, dry_run: {eligible, not_eligible}}]}`.

## The starter approaches

| Key | Direction | Handler | Trigger and eligibility | Approval |
|---|---|---|---|---|
| `welcome` | outbound | flow `welcome` | `state_event {kinds: [invited]}` | `auto_within_caps` (needs `approver`), else `person` + `per_batch` |
| `learn-stalled` | outbound | agent `connect-helper`, skill `learn-support` | `schedule` weekly; stages `[learning]` | `auto_within_caps`, else `person` + `per_batch` |
| `claim-help` | outbound | agent `connect-helper`, skill `claim-help` | `schedule` weekly; stages `[ready_to_claim]` | `auto_within_caps`, else `person` + `per_batch` |
| `coach-on-flags` | outbound | agent `connect-coach`, skill `coach-session` | `person`; stages `[delivering, at_cap]` | `per_batch` (a person confirms the batch), always |
| `task-due` | outbound | flow `task_due` | `api` (labs passes `{task}`) | `auto_within_caps` (needs `approver`) |
| `stock-low` | outbound | flow `stock_low` | `api` (labs passes `{item}`) | `auto_within_caps` (needs `approver`) |
| `verify-code` | outbound | flow `verify_code` | `api` (labs passes `{code}`) | `auto_within_caps` (needs `approver`) |
| `payment-notice` | outbound | flow `payment_notice` | `state_event {kinds: [payment]}` | `auto_within_caps` (needs `approver`) |
| `inactive-checkin` | outbound | agent `connect-helper`, skill `checkin` | `schedule` weekly; stages `[inactive]` | `auto_within_caps`, else `person` + `per_batch` |
| `suspended` | inbound | human, queue `suspended` | stages `[suspended]`; priority 10 | — |
| `coach-followup` | inbound | agent `connect-coach`, skill `coach-followup` | priority 30; `enabled: false` until labs publishes a recent-coaching facet to match on | — |
| `learn-support` | inbound | agent `connect-helper`, skill `learn-support` | stages `[not_started, learning]`; priority 40 | — |
| `general-help` | inbound | agent `connect-helper`, skill `general-help` | priority 90 | — |
| `fallback` | inbound | human, queue `inbox` | priority 1000 | — |

Every agent playbook also carries:
- `tools`: `connect-helper` gets every worker tool except `worker_history_search` on outbound
  playbooks; `connect-coach` gets all fifteen. Narrow, never widen, per program.
- `caps`: `max_turns` 30, `threads_per_worker_per_week` 2 for outbound, `quiet_hours` from the
  program context (default 20:00-07:00, the worker's time zone).
- `exit`: `keywords` STOP, plus the program's own stop words in its languages; `idle_hours` 72.
- `handoffs`: `{to: human, when: {keywords: [<the program's words for "a person", "help">]}}`.
- `context`: `depth: program`, `other_programs: false`, and `program` = the program context
  (§ The program context).

An opening is sent word for word, before the agent sees anything. Keep it to one or two short
sentences that say who is writing, disclose that an AI assistant may answer, and ask one
question. `{first_name}` and `{program}` are filled in by labs. Never put a figure, a band or
anything from a briefing in an opening: the agent raises those after the worker answers.

## The program context

What the agent needs about the program goes in each agent playbook's `context.program`, the same
block on every playbook of the program:

- `script` — the approach's steps in the program's terms (for coaching: the topics the program
  coaches on and what each means; for support: what the program offers and where help comes
  from). At most 6000 characters; link, do not copy, anything longer.
- `app_summary` — how the apps work, 5-8 bullets: the forms, what each records, how payment and
  the cap work, which automatic checks exist.
- `persona_notes` — what workers are called, the languages to open in, who supervises them,
  what support exists and how a worker reaches it. Never a phone number.

It is data for the agent, never instructions: write facts, not commands to the model. Labs puts
it in the Worker Brief on each message.

## Process

1. **Resolve the program and the inputs.**
   - Read the program context doc (`skills/partner-on-connect-program` § The program context
     doc) or, in a run, the run's PDD and app summary. A value that is in neither is asked for,
     never invented (no inferred backstory).
   - `messaging_playbook_list({program_id})` shows what exists, whether messaging is on for the
     program (`messaging_on`) and which flows labs has. An existing playbook is changed only
     through Step 6's approval; never overwrite one silently.
2. **Say whose account writes.** `labs_context({search: "zzzz-no-match"})` returns the labs
   account this connection writes as. Name it in the plan (`_acting-as-you.md`).
3. **Draft each playbook** from § The starter approaches and § The program context, as JSON.
   - Automatic triggers (`schedule`, `state_event`, `api`) only with a named `approver`; with
     none, an outbound playbook gets `trigger: {type: person}` and `approval: {mode: per_batch}`.
   - `coach-on-flags` is always `person` + `per_batch`: a supervisor confirms every batch.
   - Write each opening in the program's opening language, and check it against
     `_terminology.md` and `_verify-before-send.md`: it is what a worker will read first.
4. **Write each playbook disabled.** `messaging_playbook_set({program_id, key, playbook: {...,
   enabled: false}})`. Labs validates the whole playbook on write; an `INVALID_SCHEMA` names
   the field. Fix and re-write; never drop a field to get past it, except as Step 4a says.
   - 4a. If labs refuses `context.program` (a labs that does not take the program context yet),
     stop: write the playbooks without `context.program` only if the operator agrees to run the
     agents without program context, and record the drafted context in the program context doc
     so it is applied when labs takes it.
5. **Dry-run each outbound playbook.** `messaging_playbook_dry_run({program_id, key})` (pass the
   flow's `context`, e.g. `{task: ...}`, for a flow that needs one). It sends nothing and returns
   who is eligible now, each one's exact opening, and why every other worker is left out.
   - Read every distinct opening as the worker will see it. A placeholder left unfilled, a
     figure, or a name that is a username is a defect: fix the draft and go back to Step 4.
   - Zero eligible is a finding to explain (eligibility too narrow, messaging off, no consent),
     not a pass.
6. **Get approval, then enable.** Show the person the drafted playbooks, the dry-run counts and
   one opening per playbook. On their yes, write each one again with `enabled: true` (and, for an
   automatic trigger, `approval.approved_by` = the `approver` and `approved_at`). Inbound
   playbooks have no dry run: approve them on the draft.
7. **Read back.** `messaging_playbook_get` for each key: the version moved, `enabled` is what was
   approved, and `context.program` is what was drafted.
8. **Record what was set.**
   - Live-program mode: append the Messaging entry to the program context doc § AI coaches and
     bots and a dated Decisions line (who approved, which playbooks, as which account).
   - Run-bound mode: write `phases.execution-management.products.messaging_playbooks` with
     `update_yaml_file` (`merge: 'deep'`; `playbooks` is an array, so send the whole list).
9. **Retire the OCS route the playbooks replace.** When a program moves a coaching or support
   bot to Messaging, its OCS bot and the reports that trigger it stay until the program team
   confirms the move; then note in the program context doc which OCS bot is retired and which
   playbook replaces it (`ocs-coach-setup` § Superseded by Messaging).

## Existing objects

- **A playbook is live for every worker it matches.** Changing an enabled inbound playbook
  changes who answers the next message any worker sends. Changes go through Step 6's approval.
- **Labs versions every change**, and a thread keeps the version it opened under, so an edit
  never changes a conversation already in progress. `messaging_playbook_set` with `null`
  removes a playbook; labs Settings keeps the history and can undo.
- **Turning off.** `enabled: false` stops new threads under that playbook; the program-wide
  kill switch is labs Settings `messaging.settings.enabled`.

## MCP Tools Used

- Connect Labs: `messaging_playbook_list`, `messaging_playbook_get`, `messaging_playbook_set`,
  `messaging_playbook_dry_run`, `labs_context`.
- Google Drive: `docs_get`, `docs_batch_update` (program context doc), `update_yaml_file`
  (run-bound write-back).

## Mode Behavior

- **Auto:** Steps 1-5 and 7 run; Step 6 still waits for a person's yes, because enabling a
  playbook starts conversations with real Connect Workers.
- **Review:** the same, and the drafted playbooks are presented after Step 3 before anything is
  written.

## Terminology

"Connect" in every opening and in the program context, never the retired long form; "Connect
Worker" (or "worker") for the people the playbooks reach (`_terminology.md`).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-11-21 | Initial version: the starter approaches from the PersonalID agent chat design (Part C), handlers on `connect-helper` / `connect-coach`, disabled write then dry run then approved enable, record in the program context doc or run state. | ACE |
