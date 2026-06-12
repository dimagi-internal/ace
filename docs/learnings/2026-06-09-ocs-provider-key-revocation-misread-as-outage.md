# OCS provider-key revocation misread as a platform outage

**Date:** 2026-06-09 · **Run:** bednet-spot-check/20260609-0909 · **Issues:** jjackson/ace#742 (closed), jjackson/ace#743 (closed)

## What happened

Phase 5's quick gate failed every prompt with OCS's generic fallback —
"Sorry something went wrong. This was likely an intermittent error related
to load." — deterministically, in ~2.4s, on the per-opp chatbot AND the
pristine golden template (11792). The session diagnosed a **team-wide OCS
platform outage**, blocked the phase, escalated, and halted the run. A
resume session re-probed for ~8 minutes, confirmed "still down", and halted
again.

The real cause: the connect-ace team's Anthropic LLM provider key (1P item
`ACE - Anthropic API Key (OCS connect-ace)`, created 2026-04-10, never
rotated) had been **revoked at Anthropic's end**. Every generation failed
`401 {'type':'authentication_error','message':'invalid x-api-key'}`. Total
cost of the misdiagnosis: one blocked run, one wasted resume session, and a
platform escalation for a 5-minute credential fix.

**Confirmed cause (2026-06-12):** Jon had deactivated the key in the
Anthropic console himself, not realizing it backed the OCS connect-ace
provider — console key names don't show what consumes them. He re-enabled
it; ACE restored it on provider 377 (reverting the interim swap to the
general ACE key) and re-verified live. The 1P item now carries an "update
provider 377 first" warning for future deactivations.

## Why the misdiagnosis happened (two compounding masks)

1. **OCS masks the real error.** `apps/experiments/task_utils.py` replaces
   any non-user-facing generation error with the generic "load" fallback
   unless the experiment has `debug_mode_enabled`. The poll payload carries
   zero diagnostic signal.
2. **The control was contaminated.** "Golden template fails identically"
   was read as proof of platform scope. But the golden template sits behind
   the SAME team provider record, so it fails identically for any
   team-scoped credential failure too. The control only discriminates
   per-opp config vs upstream — it cannot separate "OCS is down" from "our
   team's key is dead."

A third near-mask: the failure began the same day OCS deployed session-token
enforcement (#3552) and ACE shipped the token-threading fix (#742), so the
contract-drift explanation absorbed all suspicion first.

## How the truth was found

`GET /api/sessions/<session_id>/` (REST token) → the failed message's
`metadata.trace_info[].trace_url` → fetch `/a/connect-ace/traces/<id>/`
with team session cookies → the trace page shows the raw provider error.
Then: pull the candidate key from 1P, verify it against
`api.anthropic.com/v1/messages` directly (it was 401 too — revoked at the
source, not stale-in-OCS), find a valid in-scope key (`ACE - Anthropic API
Key`), verify it (200), POST it to the provider edit form
`/a/connect-ace/service_providers/llm/377/`, and re-run the live widget
round-trip (real answer → fixed).

Gotcha discovered en route: `OCS_LLM_PROVIDER_ID` in `.env` (378) is the
**OpenAI embeddings** provider used for collections, NOT the chat provider
(377). Discover chat-provider pks via `…/service_providers/llm/table/`.

## Preventers shipped

- **Atom-level (class preventer):** `mcp/ocs/backends/rest.ts ::
  describeSessionTrace` — every `sendTestMessage: OCS generation error`
  throw now appends `[session <id>; underlying trace: <abs-url> …]`,
  fetched best-effort from the sessions API. The generic fallback can no
  longer reach a triage agent without its trace pointer.
- **Skill-level:** `ocs-chatbot-qa` Step 5.9 makes trace triage mandatory
  on circuit-break/all-fail; "platform outage" may not be written into
  blocker text from the fallback alone.
- **Agent-level:** `agents/ocs-setup.md` § Failure Modes branches on the
  trace's underlying error; `authentication_error` routes to provider
  re-key, not config rebuild or escalation.
- **Playbook:** `playbook/integrations/ocs-integration.md` § Troubleshooting
  carries the full triage + repair recipe.

## Durable lessons

- **A shared upstream dependency invalidates a "control" test.** Before
  declaring platform scope, probe through a surface that does NOT share the
  suspect dependency — or read the dependency's own error channel (the
  trace) directly.
- **Generic fallbacks are masks, not evidence.** When a system replaces
  errors with boilerplate, find its real error channel (traces, session
  APIs, logs) before classifying the failure. Sibling of "close the loop to
  the source of truth."
- **Long-lived credentials die without warning.** The key was 2 months old
  and worked the previous day. Deterministic, instant, scope-wide failure
  onset is the credential-death signature; genuine load problems are
  intermittent.
- **A credential's consumers must be discoverable from where it gets
  killed.** The deactivation happened in the Anthropic console, where the
  key's name carried no hint that OCS connect-ace depended on it. Defense:
  name console keys after their consumer (e.g. `ocs-connect-ace-provider`),
  and keep the 1P item's notes pointing at the exact dependent config
  (provider 377 URL) so either surface answers "what breaks if I kill
  this?"
