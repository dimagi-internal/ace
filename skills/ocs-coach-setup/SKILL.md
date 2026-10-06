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

**ACE never triggers coaching.** This skill builds and tests the Coach. A person
starts each conversation from the Labs run page — the workflow's
`start_ocs_outreach` action, from its button or by asking the page's canopy agent
("start coaching sessions for the red facilitators"), which previews and waits for
a yes. QA conversations to Dimagi staff use the action's `deliver_to` argument.

## When it runs

After `ocs-agent-setup` (it clones that bot, so it inherits the model and the opp
collection), and after Phase 7 has authored the semantic registry — the Coach's
topic keys ARE the registry's indicator ids. In a run where Phase 7 has not
happened yet, run it at the Phase 7 boundary; re-run it whenever the registry
version changes.

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
5. **Build:**

   ```bash
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/ocs-coach-build.ts" --team <team> --experiment <id> \
     --prompt <prompt.md> --collections <opp collection id> --connect-bot-name "<Programme> Coach"
   ```

   Splices `templates/ocs-coach/status_node.py` between the LLM and End nodes,
   sets prompt + collection, and creates the `commcare_connect` channel. If the
   channel step fails with *flag_commcare_connect*, the OCS team lacks that feature
   flag: record it as a residual naming the team and continue — the API-channel QA
   below does not need it.
6. **Publish** with `ocs_publish_chatbot_version`.
7. **QA with a simulated worker** over the OCS chat-completions API
   (`POST /api/openai/<public_id>/chat/completions`, team API key), never the
   Connect channel. First user message = a briefing from `renderBriefing`; then play
   the worker. Cover at least: (a) agrees → a specific plan; (b) disputes with a
   credible reason the data would miss → recorded `agreement=disputed`, no
   commitment pushed; (c) a safety disclosure → `[[COACH_ESCALATE:...]]`. After each,
   read the session's `participant_data` (`GET /api/sessions/<id>/`) and check
   `chatbot_topics`, `chatbot_review_needed`, `chatbot_task_status`. Run every
   assistant message through `findOverstatements` — any hit fails the QA.
8. **Write back** `phases.ocs-setup.products.ocs_coach` (deep merge):
   `experiment_id, public_id, team_slug, pipeline_id, admin_url, name,
   published_version_number, collection_id, registry_id, topic_keys[],
   connect_channel, qa`.
9. **Wire the Labs workflow** (Phase 7's worker-review workflow for the opp/program):
   `workflow_update_definition` adding
   `config.actions: [{key: "initiate_ai_coach", type: "start_ocs_outreach", label: "Start coaching", defaults: {bot: "<public_id>"}}]`
   and `config.agent: {share: true}`. Do this when no DDD render of that workflow
   is in flight — the canopy panel appears on the page once `share` is on.

## The briefing a person (or the page agent) sends

`prompt_text` for each worker is `renderBriefing(...)`: the worker's name and, per
red indicator in priority order, `label [KEY] — numerator of denominator (pct), band`,
plus up to three dated examples. Pass the same keys as the action item's
`indicators` so Labs can compare `chatbot_topics_done` against them.

## Terminology

Worker-facing text follows `skills/_terminology.md` — the platform is "Connect".
