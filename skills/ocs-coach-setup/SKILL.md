---
name: ocs-coach-setup
description: >
  Build and QA the per-run OCS Coach a supervisor triggers from Labs to coach a
  flagged worker. Never sends to a real worker.
disable-model-invocation: false
---

# OCS Coach Setup

Design and rationale: `docs/superpowers/specs/2026-10-06-ocs-coach-design.md`
(including the review of the real KMC Audit bot this generalises).

**ACE never triggers coaching** — except to its own Connect test user, to record itself
answering (`skills/coach-session-capture`, owner carve-out 2026-10-07). This skill builds and tests the Coach. A person
starts each conversation from the Labs run page — the workflow's
`start_ocs_outreach` action, from its button or by asking the page's canopy agent
("start coaching sessions for the red facilitators"), which previews; the person
then sends with the Send button on Labs' coaching card in canopy's chat (MCP Apps,
connect-labs#2348). The agent never holds a send token for a worker. QA conversations to Dimagi staff use the action's `deliver_to` argument.

## When it runs

Phase 7 Step 1.9 (`agents/synthetic-data-and-workflows.md`), after the semantic
registry and programme report exist — the Coach's topic keys ARE the registry's
indicator ids — and after Phase 5's Q&A bot, which it clones for the model and the
opp collection. Re-run it whenever the registry version changes.

**Required, not best effort.** The Coach is a Phase 7 product: Phase 7 cannot be
`done` without `products.ocs_coach.experiment_id` and `products.ocs_coach.coaching_on`
(`lib/phase-products-schema.ts` `REQUIRED_PRODUCT_KEYS`, checked at the phase
boundary). A failure in any step below is a defect to fix and re-run, not a
residual to record — we know the Coach builds (Spark Coach 13972).

## Inputs

| Source | Used for |
|---|---|
| `phases.ocs-setup.products.ocs_chatbot.experiment_id` | clone source (model, collection) |
| `phases.synthetic-data-and-workflows.products.synthetic.cascade.registry.registry_id` | indicator cards (`semantic_registry_get` → `indicators_doc.measures`) |
| `3-commcare/pdd-to-deliver-app_summary.md` | the short "how the app works" section |
| PDD § worker noun, languages | `--worker`, `--workers`, `--language` |

## Steps

1. **Clone.** `ocs_clone_chatbot({template_id: <Q&A experiment_id>, new_name: "ACE Coach - <opp> (<run-id>)"})`.
   Run-scoped name, as for the Q&A bot (ace#1017).
2. **Indicator measures.** Write `indicators_doc.measures` to a local JSON file.
   Only measures with `meta.flw_applicable: true` and a `direction` other than
   `none` become topics (`lib/coach-briefing.ts` `coachableIndicators`).
3. **App summary.** 5–8 bullets from the Deliver summary: the forms, what each
   records, how payment and the cap work, which automatic flags exist, the app's
   languages. Facts only — no inferred backstory.
4. **Render** the prompt:

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/render-coach-prompt.ts" --measures <json> --app-summary <md> \
     --program "<programme>" --worker <noun> --workers <plural> --out <prompt.md>
   ```


   It refuses an unfilled placeholder. Read the cards it prints: a data-quality
   signal must read as a REVIEW FLAG; an outcome with no target must say so.

   **Case coaching** (one case, one story per conversation —
   `docs/superpowers/specs/2026-10-09-case-coaching-design.md`): add
   `--case-stories kmc` to also give the Coach the case cards. Labs writes the case
   briefing; the cards are `lib/coach-briefing.ts` `KMC_CASE_STORIES`.
5. **Build:**

   ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/ocs-coach-build.ts" --team <team> --experiment <id> \
     --prompt <prompt.md> --collections <opp collection id> --connect-bot-name "<Programme> Coach"
   ```

   Splices `templates/ocs-coach/status_node.py` between the LLM and End nodes,
   sets prompt + collection, and creates the `commcare_connect` channel. A clone
   keeps its source's collections unless you pass some: `--collections none`
   detaches them all (a coach cloned from another programme's coach must not search
   that programme's documents). If the
   channel step fails with *flag_commcare_connect*, the OCS team lacks that feature
   flag: that team cannot deliver coaching to a worker's Connect app, so stop and
   report it (name the team) — the flag must be switched on, then re-run this step.
6. **Publish** with `ocs_publish_chatbot_version`.
7. **QA with a simulated worker** — prefer `skills/coach-session-capture` web mode, which
   starts the session exactly as Labs does (opening verbatim, briefing in
   `session_state.coach_briefing`). Author the worker's lines for THIS opp from its
   PDD and app summary and pass them as `--turns` (that skill's § Worker turns); the
   built-in default is programme-neutral, never another programme's script (ace#2804).
   The chat-completions route below puts the briefing in
   the conversation instead, which is not the production path. Fallback: over the OCS chat-completions API
   (`POST /api/openai/<public_id>/chat/completions`, team API key), never the
   Connect channel. First user message = a briefing from `renderBriefing`; then play
   the worker. Cover at least: (a) agrees → a specific plan; (b) disputes with a
   credible reason the data would miss → recorded `agreement=disputed`, no
   commitment pushed; (c) a safety disclosure → `[[COACH_ESCALATE:...]]`. After each,
   read the session's `participant_data` (`GET /api/sessions/<id>/`) and check
   `chatbot_topics`, `chatbot_review_needed`, `chatbot_task_status`. Run every
   assistant message through `findOverstatements` — any hit fails the QA.
8. **Write back** `phases.synthetic-data-and-workflows.products.ocs_coach`
   (`merge: 'deep'`, `validateAs: {kind: 'phase-products', phase: 'synthetic-data-and-workflows'}`).
   Phase 7 builds the Coach, so it lives in Phase 7's block; runs before
   2026-10-07 (Spark `20261004-1706`) recorded it under `phases.ocs-setup.products`:
   `experiment_id, public_id, team_slug, pipeline_id, admin_url, name,
   published_version_number, collection_id, registry_id, topic_keys[],
   connect_channel, qa`.
9. **Put coaching on the standard reports.** Coaching lives on the reports Phase 7
   already builds — the programme report (`products.synthetic.cascade.programme_report`)
   and every partner's opportunity report (`cascade.opp_reports[]`) — not on a copy.
   On each, `workflow_update_definition` with:

   ```json
   {"config": {
     "agent": {"share": true},
     "actions": [{"key": "initiate_ai_coach", "type": "start_ocs_outreach",
                  "label": "Start coaching",
                  "defaults": {"bot": "<ocs_coach.public_id>"}}]
   }}
   ```

   `config` shallow-merges, so this keeps the report's other keys. The report's own
   render shows the declared action as a button on worker rows, and `share` puts the
   canopy panel on the page, so "start coaching for every red facilitator" works there.
   Because Step 1.9 runs before the DDD render, the panel and the button are part of
   the page the demo films — coaching is a feature of the report, not an add-on.
   Confirm with `workflow_run_context` (the action is listed with this bot) and
   `workflow_run_indicators(band: "red")` (workers come back), and record
   `ocs_coach.coaching_on: [{workflow_id, run_id, url}]`.

   Rebuilding the Coach (a new `public_id`) means patching these reports again.

## The briefing

Labs composes it (connect-labs #2280, `connect_labs/workflow/run_grading.py`): for
each worker without a `prompt` of their own, the action builds the `renderBriefing`
shape from that worker's graded cells — red topics first, then yellow, coachable
(`flw_applicable`) indicators only — records the topic ids as the task's
`coaching_indicators`, and shows the composed briefing in the preview. Workers with
nothing red or yellow are skipped with a reason. So **do not put a briefing in
`defaults.prompt`**: anything there is appended to every worker's briefing under
"Programme team's note:". Leave it unset, or use it for a genuine standing note.

The report shows "Start coaching" only on workers who are off target or on watch;
Dimagi staff coaching one worker get a "Send to me instead (QA)" box (`deliver_to`).

## The briefing picture (optional)

A Coach can open with a picture of the worker's OWN figures. It is optional on
both sides: nothing changes for a session that does not ask for one.

- **Labs** (`start_ocs_outreach` with `include_image: true`, or a workflow default)
  adds two keys to the session data: `coach_image_url`, a signed link (7 days) to a
  chart Labs renders from the same topics as the briefing, and
  `coach_image_caption`, one sentence naming what it shows.
- **The status node** (`templates/ocs-coach/status_node.py`) fetches that link once,
  on the Coach's first reply, and attaches the PNG with OCS's
  `add_file_attachment`. A failure never blocks the reply: it lands in session
  state `coach_image_error` and the reply goes out as text. The code decides, not
  the model, so the picture cannot repeat (the model DOES re-send media it chose
  itself — ace#2822).
- **The prompt** reads `{session_state.coach_image_caption}`: empty means no
  picture, and the Coach must not mention one.
- **The fetch authenticates** with an OCS Auth Provider named exactly
  `connect-labs` (type Bearer) on the Coach's OCS team, holding a Labs token of
  scope `coach-images` (minted at `/labs/mcp/tokens/`). That token can fetch
  coaching pictures and nothing else. Without the provider every fetch fails into
  `coach_image_error`, so add it once per OCS team that runs Coaches.
- Connect delivers the picture only on apps with rich messaging (CommCare 2.66+,
  commcare-android#3946); older apps show an "update your app" notice instead.

## Terminology

Worker-facing text follows `skills/_terminology.md` — the platform is "Connect".
