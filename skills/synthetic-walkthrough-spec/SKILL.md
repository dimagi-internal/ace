---
name: synthetic-walkthrough-spec
description: >
  Generate per-persona walkthrough YAML specs from the narrative plan and
  persona catalog. Each spec drives a canopy:walkthrough run.
disable-model-invocation: true
---

# Synthetic Walkthrough Spec

Stage 2 of ACE Phase 7 (Plan B). Reads the narrative plan and the persona
catalog (canned + opp-specific overlays) and emits one walkthrough spec
YAML per persona. Each spec is the input to a `canopy:walkthrough` run via
the `synthetic-walkthrough-run` skill.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 7 | `7-synthetic/synthetic-narrative-plan.md` | the data story — informs scene narration |
| Phase 7 | `7-synthetic/synthetic-narrative-plan.yaml` | manifest — anomaly weeks, FLW names, KPI thresholds for "wow moment" assertions |
| Phase 7 | `7-synthetic/synthetic-data-generate.md` | labs URL, fixture folder ID, record counts |
| Phase 7 (optional) | `7-synthetic/synthetic-workflow-seed.md` | workflow IDs + saved-run **render deep-links** (`/run/<run_id>/?opportunity_id=`) — use these verbatim for any workflow-dashboard scene (see authoring rules) |
| Plugin | `personas/<persona>.md` | canned persona catalog (currently `prospective-llo.md`, `funder.md`) |
| Drive (optional) | `ACE/<opp>/personas/*.md` | per-opp persona overlays — override or supplement the canned set |
| Drive | `ACE/<opp>/opp.yaml` | `display_name`, `slug`, `synthetic.labs_opp_id`, `synthetic.current_folder_id` |

## Products

- One `7-synthetic/synthetic-walkthrough-spec_<persona>.yaml` per persona
- `run_state.yaml.phases.synthetic-data-and-workflows.synthetic-walkthrough-spec.steps[<persona>]: done`

## Process

1. **Discover personas.**

   - Always include `prospective-llo` and `funder` from the plugin's
     `personas/` directory (canned catalog).
   - Additionally, read `ACE/<opp>/personas/` (Drive). Any `*.md` file
     there is treated as an opp-specific persona — if its name
     collides with a canned one, the opp-specific overlay wins
     entirely (no merge — the opp file is the authoritative version).
   - Operator can override the persona set with `--personas <comma-list>`
     (e.g., `--personas funder` to skip prospective-llo this run).

2. **Read inputs.** Load the narrative plan, manifest, data-generate
   summary, opp.yaml, and each persona file via `drive_read_file` /
   the local `personas/` files (filesystem read for canned).

   If `synthetic-narrative-plan.yaml` is missing, halt with: "Run
   `/ace:step synthetic-narrative-plan --opp <slug>` first — this skill
   composes specs from the narrative plan."

   If `synthetic-data-generate.md` is missing, halt with: "Run
   `/ace:step synthetic-data-generate --opp <slug>` first — specs need
   the labs URL and fixture folder."

3. **Derive scene plan per persona.**

   For each persona, work through 5–8 scenes that map their priorities
   to actual labs URLs the synthetic data populates. The shape varies by
   persona; common scene types (atomic-visit archetype):

   - **Headline panel** — the opp's labs page top-of-screen, KPI numbers
     visible. Wow: a specific number from the manifest's record_counts
     ("138 visits in 4 weeks across 50 vendors").
   - **FLW roster** — the per-FLW page. Wow: a named FLW the manifest
     features — "Asha M. delivered 38 visits at 92% completeness."
   - **Single-FLW deep-dive** — drill into the rockstar OR the
     struggling FLW, depending on persona priority. Wow: archetype
     marker visible (e.g., "rockstar" badge or a "needs review" flag).
   - **Anomaly callout** — a labs page that surfaces one of the
     manifest's seeded anomalies. Wow: the anomaly is visibly marked
     with context, not just a flag color.
   - **Coaching task drawer (Stage 3)** — Skip in Stage 2; Stage 3
     `synthetic-workflow-seed` lights this up.
   - **Visit map / list** (atomic-visit) — geographic coverage. Wow:
     density pattern, refusals visible, no mystery clusters.
   - **Quality verification flow** (funder priority) — Layer A/B/C
     visible if the opp has them configured. Wow: each layer has a
     concrete number (Layer A pass-rate, Layer B AI agreement, Layer C
     human spot-check coverage).
   - **Cost / per-visit panel** (funder priority) — the budget line vs
     what's been delivered. Wow: a $-per-verified-visit number.

4. **Assemble the YAML spec.** Use the `canopy:walkthrough` schema —
   see `~/.claude/plugins/marketplaces/canopy/plugins/canopy/skills/walkthrough/SKILL.md`
   for the canonical contract. Shape:

   ```yaml
   name: "<opp-slug>-<persona>-walkthrough"
   narrative: "<one-line thesis tuned to the persona>"
   base_url: "${LABS_BASE_URL}"   # default https://labs.connect.dimagi.com

   auth:
     type: command
     check: "test -f ~/.ace/labs-session.json && bash ~/.claude/plugins/cache/ace/ace/$(cat ~/.claude/plugins/marketplaces/ace/VERSION)/bin/ace-labs-walkthrough-login"
     login: "bash ~/.claude/plugins/cache/ace/ace/$(cat ~/.claude/plugins/marketplaces/ace/VERSION)/bin/ace-labs-walkthrough-login"
     # NOTE: labs has no /auth/e2e-login/ shared-secret bypass (only ace-web does).
     # The login script drives the full Connect-OAuth + labs-OAuth click-through
     # via Playwright, reusing mcp/connect/auth/hq-oauth-login.ts. After login,
     # cookies are imported into the gstack browse profile so canopy:walkthrough
     # picks them up. State persisted to ~/.ace/labs-session.json.

   personas:
     <persona-key>:
       name: "<persona display name>"
       role: "<persona role line>"
       color: "<hex>"      # prospective-llo: #2563eb; funder: #16a34a
       intro: "<one-sentence intro from the persona file>"

   scenes:
     - persona: <persona-key>
       title: "<scene title>"
       show: "<one-line description of what to capture; URL hint OK>"
       impressive_because: "<the wow moment — name a specific number/name from the manifest>"
       ai_quality: "<assertion the canopy walkthrough's AI judge can check, e.g.,
                     'KPI panel must show ≥3 named FLWs with archetype labels visible'>"
   ```

   **Critical authoring rules:**
   - Every `impressive_because` must reference a concrete element from
     the manifest (a named FLW, a specific anomaly, a KPI threshold).
     Generic "looks good" entries get rejected by the eval (Stage 4).
   - Every `ai_quality` must be falsifiable — name what an AI judge
     should look for, not just "the page should be nice." Use language
     the canopy walkthrough's LLM-as-Judge can apply.
   - Map at least one scene to each anomaly the manifest seeded —
     otherwise the data work in `synthetic-data-generate` is wasted.
   - Order scenes by narrative arc, not by URL convenience: open with
     the headline, build via FLW roster, climax at the anomaly +
     coaching loop, close with cost / verification.
   - **Workflow-dashboard scenes (LLO Weekly Review / Program Admin
     Audit) MUST target the saved-run render deep-link**, not the bare
     workflow URL. Use the `/labs/workflow/<id>/run/<run_id>/?opportunity_id=<opp>`
     links recorded in `synthetic-workflow-seed.md` (Render deep-links).
     The bare `/labs/workflow/<id>/?opportunity_id=<opp>` renders the run
     *picker*, not the polished per-FLW dashboard — a scene pointed there
     captures the picker and the AI judge sees no hero/FLW content. If
     `synthetic-workflow-seed.md` is absent or recorded no saved run, omit
     the workflow-dashboard scenes rather than linking the picker. (Recipe
     verified live; jjackson/ace#769.)

5. **Pick the labs base URL.** Default to `https://labs.connect.dimagi.com`.
   Read `LABS_BASE_URL` from `${CLAUDE_PLUGIN_DATA}/.env` if set; that
   override is mainly for staging environments.

6. **Validate the spec.** Before writing each YAML:
   - Required keys present: `name`, `narrative`, `base_url`, `auth`,
     `personas`, `scenes` (with at least 4 scenes).
   - Every `scenes[].persona` matches a key in `personas`.
   - Every URL referenced is under `base_url` (no absolute URLs to
     other domains).

   If validation fails, halt and surface the failure to the operator.
   Don't write a malformed spec.

7. **Write each spec** to
   `7-synthetic/synthetic-walkthrough-spec_<persona>.yaml` via
   `drive_create_file` (find-or-update; re-runs overwrite).

8. **Update `run_state.yaml`** via the read-merge-write pattern:

   ```yaml
   phases:
     synthetic-data-and-workflows:
       steps:
         synthetic-walkthrough-spec:
           status: done
           personas:
             prospective-llo:
               status: done
               spec_artifact: <Drive ID>
               scene_count: <int>
             funder:
               status: done
               spec_artifact: <Drive ID>
               scene_count: <int>
   ```

## MCP Tools Used

- `mcp__plugin_ace_ace-gdrive__drive_read_file`
- `mcp__plugin_ace_ace-gdrive__drive_list_folder` (discover opp-specific personas)
- `mcp__plugin_ace_ace-gdrive__drive_create_file` (find-or-update)
- `mcp__plugin_ace_ace-gdrive__drive_update_file` (run_state read-merge-write)

## Mode Behavior

- **Default:** generate a spec for every canned persona + every opp-overlay persona.
- **`--personas <comma-list>`:** only emit specs for the listed personas
  (e.g., `--personas funder`). Useful when iterating on one deck.

## Dry-Run Behavior

`--dry-run` writes both spec files as normal (no external side effects in
this skill); state tracks as `dry-run-success`.

## Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| `synthetic-narrative-plan.yaml` missing | step 2 halt | Run `synthetic-narrative-plan` first. |
| `synthetic-data-generate.md` missing | step 2 halt | Run `synthetic-data-generate` first. |
| Persona file empty / malformed | step 2 warn | Skip that persona with a warning; emit specs for remaining personas. |
| Spec validation fails (step 6) | step 6 halt | Fix the underlying input (likely a malformed manifest or a missing labs URL); re-run. |

## Related skills

- `synthetic-narrative-plan` — produces the narrative + manifest this
  skill consumes.
- `synthetic-walkthrough-run` — Stage 2 sibling that consumes each
  spec written here and dispatches `canopy:walkthrough`.
- `synthetic-summary` — links the persona slideshows produced by
  `synthetic-walkthrough-run`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-06 | Initial Stage 2 skill — per-persona spec authoring with canned + opp-overlay persona catalog | ACE team (Plan B Stage 2) |
| 2026-06-13 | Workflow-dashboard scenes (LLO Weekly Review / Program Admin Audit) must target the saved-run render deep-link (`/labs/workflow/<id>/run/<run_id>/?opportunity_id=<opp>`) from `synthetic-workflow-seed.md`, not the bare workflow URL (which renders the run picker). Omit those scenes when no run was saved. Added `synthetic-workflow-seed.md` to Inputs. See `docs/learnings/2026-06-13-labs-workflow-run-deeplink.md` (jjackson/ace#769). | ACE team |
