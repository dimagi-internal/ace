---
name: ocs-widget-handoff-eval
description: >
  Grade the OCS widget-handoff staging artifact for HITL paste-in —
  widget URL, embed key, opportunity-binding instructions.
disable-model-invocation: false
---

# OCS Widget Handoff Eval

The OCS chatbot is staged at the end of Phase 5 (`ocs-setup`) so the LLO can
reach it. **Connect has no per-opportunity widget field today (CCC-301), so
there is nothing to paste it into** — `connect_update_opportunity` carries no
widget parameter and `mcp/connect/` contains no widget or embed surface at all.
The route that works right now is the bot's **public chat URL**, which needs no
configuration hop.

This rubric grades the staging artifact (`ocs-setup/widget-handoff.md`) on
whether it gives the operator what they can actually use today: a live public
chat URL, the credentials held for when CCC-301 ships, the opportunity this bot
is bound to, and a way to verify they are talking to the right bot.

See `skills/_eval-template.md` for shared contracts. Authored 0.10.29 to
absorb turmeric run_time_followups item 10 (HITL widget paste-in until
CCC-301).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 5 | `5-ocs/ocs-setup_widget-handoff.md` | staging artifact under judgment |
| Phase 5 | `5-ocs/ocs-agent-setup.md` | cross-check `embed_key`, `experiment_id`, `public_id` |
| Per-run | `runs/<run-id>/run_state.yaml` | `connect_opportunity.url` |

## Products

- `5-ocs/ocs-widget-handoff-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect missing artifacts.** If `widget-handoff.md` is missing,
   emit `verdict: incomplete` with `[INFO] widget-handoff.md not
   found — Phase 5 ocs-setup did not write the staging artifact, or
   the LLO already pasted in and the artifact was archived`.

3. **Grade across 4 dimensions.**

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Widget URL resolves** | 25% | The handoff must carry the bot's **public chat URL** — `https://www.openchatstudio.com/a/<team_slug>/chatbots/<public_id>/start/`, built with `buildOcsPublicChatUrl` from `lib/ocs-public-chat-url.ts` — plus the `public_id` and a non-empty `embed_key` for the widget element. Probe it anonymously and require a **200**. **The probe MUST carry cookies through the redirect** (`curl -L -c jar -b jar`, or a Playwright context): `start_session_public` creates a session and 302s to `/s/<session_id>/chat/`, which is wrapped in `@verify_session_access_cookie`, so a cookieless fetch reads **404 on a perfectly working bot**. Verified live 2026-08-14 against `connect-ace` / `f92d26f3-…`: no jar → 302 then 404; with jar → 200. URL-shape-correct but genuinely unreachable = ≤6 ([PLATFORM]). **A `503` carrying OCS's maintenance page is `[PLATFORM]`, never a handoff defect** — `start_session_public` returns it when the team's `platform=WEB` `ExperimentChannel` is disabled (OCS #4230), a team-wide admin kill-switch that takes down every ACE per-opp chat URL at once and says nothing about this artifact. Score the URL on its shape and note the cause; do not deduct (ace#1812). URL-shape-broken, or the retired `/chatbots/embed/<public_id>/` path (a 410 stub since OCS #3540, 2026-08-03) = ≤3. **Do NOT deduct for the absence of an embed page** — there isn't one, and the handoff naming the `start/` route instead is correct, not a defect (ace#1021). |
   | **Connect opp binding** | 20% | widget-handoff.md must name the Connect opportunity this chatbot is bound to, so a reader can tell which opp's bot they hold — an opp typically has several runs' bots and they look alike. This is an IDENTITY reference, **not a paste target**: there is no per-opportunity widget field to paste into (see the header). Mismatch with run_state.yaml's `connect_opportunity.url` = 4-point deduction. Missing = ≤4. |
   | **Operator instructions clarity** | 30% | The handoff must tell a non-technical reader (a) **what to do today** — share the public chat URL, which requires no configuration step — (b) how to verify they have the right bot (a chat-test prompt whose answer is opp-specific), and (c) what the `public_id` / `embed_key` are for, namely the embed that becomes possible when CCC-301 ships. Each missing element = 2-point deduction. **Requiring a Connect paste-in is an AUTO-FAIL for this dimension, not a bonus** (≤3): an instruction to find a "support chatbot / help widget field group" sends a reader hunting for a UI element that does not exist, and four sibling skills — `training-faq`, `training-quick-reference`, `training-flw-guide`, `_training-template` — state so verbatim. A handoff that says plainly *no paste-in is possible yet* is CORRECT and scores full marks (ace#1811). |
   | **Credential hygiene** | 25% | `embed_key` is opp-specific (an OCS bot-level value), NOT a global API key — its presence is expected and is never a finding. The guard protects against exactly one thing: a **credential that grants access beyond this single opportunity** appearing in an LLO-facing artifact — `OCS_API_TOKEN`, `OCS_PASSWORD`, `OCS_GOLDEN_TEMPLATE_ID`, `LABS_MCP_TOKEN`, or any HQ / Connect credential. Surface a `[WARN]` per such value; a leak is the auto-fail below. **`team_slug` and `public_id` are public-by-construction and are NEVER a hygiene finding.** The anonymous chat route is team-scoped, so the URL `widget_url_resolves` REQUIRES (row above) necessarily contains the team slug — deducting for it would fail a correct handoff on the strength of the dimension that mandates it (ace#1680). |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`.
   - Inflation guard: ≥2 `[WARN]` → cap at 8.5.
   - `[PLATFORM]` and `[DRIFT]` do NOT count.

   **Verdict tiers:**
   - `pass` — overall ≥ 7.0, no dimension ≤ 3, widget URL fetched 200.
   - `partial` — overall ≥ 7.0 but the widget HTTP probe failed at
     grading time. Cap 8.5; `live_state_verified: false`.
   - `warn` — overall ≥ 5.0 < 7.0 OR inflation cap binds.
   - `fail` — overall < 5.0 OR any dimension ≤ 3 OR a credential that
     grants access beyond this opportunity leaked into the handoff
     (auto-fail; security guard). `team_slug` and `public_id` are not
     credentials — see the `credential_hygiene` row.
   - `incomplete` — widget-handoff.md missing.

4. **Severity tiers:**
   - `[BLOCKER]` for any dimension ≤ 3, missing Connect opp link, or
     credential leak (a cross-opportunity credential in an LLO-facing
     doc). Never for `team_slug` / `public_id`.
   - `[BLOCKER]` if overall < 7.0.
   - `[WARN]` per missing operator-instruction element.
   - `[PLATFORM]` for the OCS public chat route returning 5xx during
     the probe (handoff structurally correct; live verification
     unavailable). A **404 with no cookie jar is not a platform issue** —
     it is a defective probe; re-run it with cookies before recording
     anything (ace#1021).
   - `[PLATFORM]` for Connect's lack of `update_opportunity` widget-config
     API (the entire reason this hop is HITL today). One canonical
     entry per verdict; ties to CCC-301.
   - `[DRIFT]` per widget-handoff claim ↔ live ocs_get_chatbot or
     run_state.yaml disagreement.
   - `[INFO]` for "public chat URL fetched OK; the LLO can be sent the link as-is."
   - `[INFO-SKIPPED]` for the live HTTP probe when offline-mode is requested.

5. **Write the verdict YAML** to
   `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-widget-handoff-eval_verdict.yaml`. The filename uses
   **this eval skill's** name (`ocs-widget-handoff-eval`), not the
   producer's (`ocs-agent-setup` — the skill that produces
   `ocs-setup/widget-handoff.md` as one of its outputs): per the 0.12.0
   Option-α rule an `-eval` skill keeps `-eval` in its verdict filename,
   and the Workbench rolls the score up to the producer row via the
   `eval_skill:` pairing in the phase agent's frontmatter, not by
   parsing the filename — see `agents/ace-orchestrator.md § Per-Step
   Eval Hook`. Body conforms to `lib/verdict-schema.ts`.

   ```yaml
   skill: ocs-widget-handoff-eval
   target: <opp-name>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: ocs-setup/widget-handoff.md

   overall_score: 8.7
   overall_score_pre_cap: 8.7
   verdict: pass
   live_state_verified: true

   dimensions:
     widget_url_resolves:           { score: 9.0,  weight: 0.25 }
     connect_opp_binding:           { score: 9.5,  weight: 0.20 }
     operator_instructions_clarity: { score: 8.0,  weight: 0.30 }
     credential_hygiene:            { score: 9.5,  weight: 0.25 }

   per_item:
     - ref: "Widget URL"
       score: 9.0
       verdict: pass
       note: "Includes public_id 1fcddd08-...; embed_key wDwe70vquTL...; HTTP probe returned 200."
     - ref: "Connect opp binding"
       score: 9.5
       verdict: pass
       note: "Names the bound opportunity and matches run_state.yaml connect_opportunity.url for 249ad8fe-...; carries it as an identity reference and correctly states no paste-in target exists yet."

   auto_surfaced:
     - severity: PLATFORM
       message: "No Connect paste-in exists yet: connect_update_opportunity carries no widget parameter (CCC-301), so the public chat URL is the working route. Rubric grades staging, not a paste-in."
     - severity: INFO
       message: "embed_key is opp-specific (OCS bot-level), not a cross-opportunity credential. Safe to surface in LLO-facing doc. team_slug/public_id are public-by-construction (they are in the mandated chat URL)."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

## LLM-as-Judge Rubric

**Provisional** until 3 real handoffs produce ground truth.

Calibration target:
- **Detection rate:** ≥ 80% of catalogued widget-handoff issues from
  `eval-calibration/known-issues.md § Widget handoff` (TBD).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

The 3 calibration runs should include:
1. A clean handoff (canonical pass).
2. A handoff missing the Connect opp link (drives BLOCKER).
3. A handoff with a leaked cross-opportunity credential — e.g.
   `OCS_API_TOKEN` (drives auto-fail).

## Archetypes

Archetype-agnostic. Widget handoff shape is identical for atomic-visit /
focus-group / multi-stage opps.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`
- ace-ocs MCP: `ocs_get_chatbot_embed_info` to cross-check embed_key
  and widget URL shape against the live bot.
- HTTP probe (no MCP): GET widget URL with a HEAD request to verify
  the endpoint returns 200 + sensible content-type.

## Mode Behavior

- **Auto:** Grade, write verdict.
- **Review:** Pause after grading.

## Dry-Run Behavior

- Read inputs normally.
- Skip the widget HTTP probe and Connect opp-link probe.
- Write verdict.
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-29 | **The rubric required an operator instruction that does not exist, and thereby caused the defect it should have caught (ace#1811).** `operator_instructions_clarity` (30%) mandated telling the LLO "where to paste (Connect opp config tab, specific field name)", and the "Connect opp link" dimension called the opportunity URL the one the LLO "needs to paste INTO". There is no such field: `connect_update_opportunity` carries no widget parameter and `mcp/connect/` contains no widget or embed surface at all, while four sibling skills state "Connect has no per-opp widget field" verbatim. A handoff that told the truth therefore LOST points, and the one that shipped on `hh-poverty-targeting/20260828-0702` sent an operator hunting for a UI element three files in the same repo say is absent. Same shape as the #1680 and #1021 rows below — a rubric demanding something the platform does not have — except this one propagated into an LLO-facing artifact. The dimension now grades what the reader can actually do today (share the public chat URL, verify the bot, hold the credentials for CCC-301) and makes requiring a paste-in an auto-fail. *Enforced:* `test/skills/widget-handoff-no-phantom-paste-target.test.ts`. | ACE team |
| 2026-08-29 | **`widget_url_resolves` can now fail for a reason that is not the handoff's fault (ace#1812).** OCS #4230 added a team-wide admin kill-switch: if the team's `platform=WEB` `ExperimentChannel` is disabled, `start_session_public` returns a **503** maintenance page for EVERY bot on the team. The rubric required a 200 and had no vocabulary for this, so a correct handoff would have been scored as a broken one during any OCS maintenance window — the same shape as the #1680 and #1021 rows below. The dimension now names a 503 maintenance page as `[PLATFORM]` (which does not count against the score) rather than a handoff defect. Weights unchanged. | ACE team |
| 2026-08-26 | **`credential_hygiene` no longer contradicts `widget_url_resolves` (ace#1680).** The dimension listed `OCS_TEAM_SLUG` as a "global secret" whose presence is an auto-fail security guard, while `widget_url_resolves` REQUIRES `https://www.openchatstudio.com/a/<team_slug>/chatbots/<public_id>/start/` — a team-scoped route, so the slug is structurally unavoidable in the one artifact the rubric mandates. A correct handoff was therefore reachable, on a literal reading, as a `fail` on a security guard; whether it failed depended on which way the judge leaned. The guard now names what it actually protects — a credential granting access beyond this opportunity (`OCS_API_TOKEN`, `OCS_PASSWORD`, `OCS_GOLDEN_TEMPLATE_ID`, `LABS_MCP_TOKEN`, HQ/Connect creds) — and states that `team_slug` / `public_id` are public-by-construction and never a finding. Weights unchanged. *Enforced:* `test/skills/credential-hygiene-vs-widget-url.test.ts`. | ACE team |
| 2026-08-14 | **`widget_url_resolves` probes the route that exists (ace#1021).** The dimension gated 25% of the score on fetching an OCS "widget endpoint", while `ocs-agent-setup` already recorded that `/chatbots/embed/<public_id>/` is a 404 — so a CORRECT handoff scored as badly as a broken one. Both skills were wrong about the platform: the anonymous route is team-scoped, `/a/<team_slug>/chatbots/<public_id>/start/` (`apps/chatbots/urls.py:80` mounted under `config/urls.py:88`), and it works. The embed flow really was deleted (OCS #3540, 2026-08-03). The probe now targets the real URL and MUST carry cookies through the 302 — `@verify_session_access_cookie` on the chat view makes a cookieless fetch read 404 on a working bot, which is the false negative that produced this issue. | ACE team |
| 2026-04-29 | Initial version. 4 dimensions: widget_url_resolves (0.25), connect_opp_link (0.20), operator_instructions_clarity (0.30 — heaviest because LLOs are non-technical), credential_hygiene (0.25 — security guard with auto-fail on global-secret leak). Provisional calibration. Absorbs turmeric run_time_followups item 10 (HITL widget paste-in until CCC-301). | ACE team (0.10.29) |
