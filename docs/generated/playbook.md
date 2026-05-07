# ACE Playbook — CRISPR-Connect Process

_Generated: 2026-05-06 (ACE 0.13.43 — 8-phase orchestration)_

Derived from `agents/*.md`, `skills/*/SKILL.md`, and
`playbook/integrations/*.md`. Regenerate with `/ace:docs` after changing any
of those sources.

## Overview

ACE (AI Connect Engine) orchestrates the full CRISPR-Connect lifecycle for
a Connect opportunity. The `ace-orchestrator` agent dispatches to **eight
phase agents** in order:

1. **design-review** — iterate idea → approved PDD + opp-specific test prompts
2. **commcare-setup** — Nova-build Learn + Deliver apps, deploy + release
3. **connect-setup** — create Program + Opportunity in Connect
4. **ocs-setup** — clone OCS chatbot template, attach RAG collection, smoke-test
5. **qa-and-training** — capture screenshots, generate per-artifact training docs
6. **solicitation-management** — publish solicitation, invite candidate LLOs
7. **execution-manager** — onboard awarded LLO, UAT, go-live, recurring monitor
8. **closeout** — invoices, feedback, learnings, cycle grade

**Phases 1–5 run end-to-end with zero LLO involvement.** Phase 6 publishes a
public solicitation listing (no targeted contact unless the PDD names
preferred LLOs). Phase 7 is the first 1-1 LLO contact and starts only when
`opp.yaml.selected_llo.org_slug` is populated by the manual `solicitation-review`
skill that runs between Phase 6 and Phase 7.

### Execution modes

- **Auto (default)** — run all phases sequentially, log gates but don't
  enforce them.
- **Review** — pause at gate steps and use `AskUserQuestion` to get operator
  approval before continuing. Gate steps:
  - After `idea-to-pdd` (Phase 1) — PDD approval
  - After `app-deploy` (Phase 2) — apps verified before Connect setup
  - After `ocs-chatbot-eval --deep` (Phase 4) — OCS quality clears the
    pre-launch bar
  - After `solicitation-review` (manual, between Phase 6 and 7) — awardee
    explicitly approved
  - After `llo-launch` (Phase 7) — opportunity activation verified

### Agent topology

ACE has one architectural rule: **anything that calls `Agent` must run at
level 0.** The orchestrator and the Phase 2 `commcare-setup` are procedure
docs the top-level session reads inline; the other seven agents are
subagents dispatched via `Agent(...)` from level 0. There are never two
levels of `Agent` dispatch. See `CLAUDE.md § Agent topology` for the full
rule and history.

## Process Flow

| Phase | Agent | Skills | Gate |
|---|---|---|---|
| 1 | design-review | idea-to-pdd → pdd-to-test-prompts + pdd-to-app-journeys | PDD approved (review mode) |
| 2 | commcare-setup | pdd-to-learn-app + pdd-to-deliver-app → app-connect-coverage → app-test-cases → app-deploy → app-release | Apps deployed + released |
| 3 | connect-setup | connect-program-setup → connect-opp-setup | — |
| 4 | ocs-setup | ocs-agent-setup → ocs-chatbot-qa --quick → ocs-chatbot-eval --quick | OCS quality (deep gate at end) |
| 5 | qa-and-training | app-screenshot-capture → training-* (6 per-artifact) → training-deck-build | — |
| 6 | solicitation-management | solicitation-create → llo-invite → solicitation-monitor (recurring) | **HALT** — manual `solicitation-review` populates `selected_llo` |
| 7 | execution-manager | llo-onboarding → llo-uat → llo-launch → timeline-monitor + flw-data-review + ocs-chatbot-qa --monitor (recurring) | UAT sign-off + launch verified |
| 8 | closeout | opp-closeout → llo-feedback → learnings-summary → cycle-grade | — |

Standalone skills (not part of the default `/ace:run`):
- `app-multimedia-coverage` — manual post-Phase-2, attaches display images
- `connect-baseline-screenshots` — cross-opp Connect-walkthrough capture
- `ocs-tester` (agent) — ad-hoc OCS quality probe
- `email-communicator` — utility skill, called by other skills
- `upload-transcript` — uploads CLI stream-json to ace-web

In-flow skills with a removal trigger:
- `commcare-form-patch` — Phase 2 Step 2.8 workaround for
  voidcraft-labs/nova-plugin#7 (Nova emits `<module>`/`<assessment>`
  wrappers in Learn-app form XML that break the AVD's CommCare
  runtime). Idempotent + no-op when zero wrappers found. Whole skill
  + the backing `commcare_patch_xform` MCP atom self-delete the day
  nova-plugin#7 ships and a clean `/ace:run` produces a wrapper-free
  Learn CCZ.

---

## Phase 1: Design Review

**Agent:** `design-review`

> Phase 1 of the CRISPR-Connect lifecycle: iterate an initial idea into an
> approved Program Design Document (PDD) and derive opp-specific test
> prompts for later OCS chatbot evaluation.

### Skills

#### idea-to-pdd
Develop a Program Design Doc (PDD) for a Connect intervention from source
material. Iterates a 5-question stress-test rubric until approved.

#### idea-to-pdd-eval
Independently grade a PDD against the source idea pack — re-runs the
stress test from outside and cross-checks reviewer-comment fidelity.

#### pdd-to-test-prompts
Derive opp-specific Q&A test prompts from an approved PDD. Produces the
ground-truth suite for the Phase 4 OCS chatbot deep gate.

#### pdd-to-app-journeys
Derive opp-specific expected user journeys from an approved PDD. Produces
the UX-intent ground truth consumed by app-test-cases and app-ux-eval.

---

## Phase 2: CommCare Setup

**Agent:** `commcare-setup`

> Phase 2 of the CRISPR-Connect lifecycle: translate the approved PDD into
> Learn and Deliver apps via Nova, deploy them to CommCare HQ, and test.

### Skills

#### pdd-to-learn-app
Build the CommCare Learn (training) app from the PDD via Nova's
/nova:autobuild. Captures nova_app_id and writes a structure summary.

#### pdd-to-learn-app-eval
Grade a Nova-built Learn app against the PDD that specified it — module
count, order, Assessment Score wiring, content coverage.

#### pdd-to-deliver-app
Build the CommCare Deliver (service-delivery) app from the PDD via Nova's
/nova:autobuild. Captures nova_app_id and writes a structure summary.

#### pdd-to-deliver-app-eval
Grade a Nova-built Deliver app against the PDD that specified it — field
count, ordering, conditional logic, Connectify wiring.

#### app-connect-coverage
Verify every form in a Nova-built Learn or Deliver app has the right
CommCare Connect markers, auto-fix via Nova edits, loop until clean.

#### app-test-cases
Bind each PDD user journey to the Nova-built app structure and emit a
Maestro recipe per journey with real selectors. Use after Nova finishes
building, before app-release.

#### app-deploy
Upload Nova-built Learn + Deliver apps to CommCare HQ as draft builds via
/nova:upload_to_hq. Captures HQ app IDs and writes a deploy summary.

#### app-release
Build and release the Learn + Deliver CommCare apps on CCHQ so Connect
can read their form schema and surface deliver units.

#### app-release-eval
Verify every Learn + Deliver build was actually released so Connect can
read deliver units. Provisional rubric pending 3+ real releases.

#### app-multimedia-coverage (manual, not part of /ace:run)
Attach display-only images to Connect app questions where they
meaningfully help FLWs. Manual gate; not part of /ace:run.

#### commcare-form-patch (Phase 2 Step 2.8, removal-tracked)
Apply surgical CCHQ form-XML patches when Nova's `compile_app` emits
output the AVD's CommCare runtime can't parse, then re-build + re-release.
Wired into Phase 2 as Step 2.8 in 0.13.66 — auto-runs after `app-release`
with `targets: auto` (no-op when zero wrappers in the released Learn CCZ).
Whole skill self-deletes when voidcraft-labs/nova-plugin#7 ships per its
own `## Removal criteria`. Workaround for jjackson/ace#115 finding 1.

---

## Phase 3: Connect Setup

**Agent:** `connect-setup`

> Orchestrates Connect platform setup for a CRISPR-Connect opportunity:
> program creation, opportunity shell, verification flags, and payment
> units. Atom-driven via the ace-connect MCP (no HITL).

### Skills

#### connect-program-setup
Create or reuse a Connect Program for the opportunity, archetype-matched
to the PDD. Captures program_id for downstream skills.

#### connect-program-setup-eval
Grade Connect Program + Opportunity configuration against the PDD —
reuse-vs-create, verification rules, delivery units, payment units.

#### connect-opp-setup
Create and fully configure a Connect Opportunity — opp shell, verification
flags, payment units, ACE test-user pre-invite for emulator testing.

---

## Phase 4: OCS Setup

**Agent:** `ocs-setup`

> Phase 4 of the CRISPR-Connect lifecycle: clone the ACE golden template,
> build the opp-specific RAG collection, smoke-test the bot via a thin
> quick chat suite, and stage the widget credentials for Connect.

### Skills

#### ocs-agent-setup
Clone the ACE OCS template into a per-opp chatbot, attach a RAG
collection from PDD + training + app summaries, publish, return embed
credentials.

#### ocs-chatbot-qa
Exercise the per-opp OCS chatbot via its anonymous widget and capture a
transcript with structural checks. Modes: --quick / --deep / --monitor.

#### ocs-chatbot-eval
LLM-as-Judge grader for OCS chatbot transcripts. Modes: --quick (1-dim
smoke), --deep / --monitor (5-dim calibrated; emits gate brief).

#### ocs-widget-handoff-eval
Grade the OCS widget-handoff staging artifact for HITL paste-in — widget
URL, embed key, opportunity-binding instructions.

---

## Phase 5: QA and Training

**Agent:** `qa-and-training`

> Phase 5 of the CRISPR-Connect lifecycle: produce per-opp QA test plan +
> walkthrough screenshots + training materials. All derived from the
> design docs (PDD, app summaries, opp identifiers, OCS chatbot URL) so
> the Phase runs from artifacts; no live LLO contact.

### Skills

#### app-screenshot-capture
Run app smoke recipes against a local AVD and capture per-step
screenshots for the training deck. Per-opp content only.

#### app-ux-eval (deep-only, /ace:qa-deep)
Grade the FLW experience of the built apps via LLM-as-Judge over
captured screenshots. Deep-only — runs from /ace:qa-deep.

#### training-llo-guide
Generate the LLO-facing operations document for overseeing FLW
deployment. Owns one artifact: llo-manager-guide.md.

#### training-flw-guide
Generate the FLW-facing step-by-step guide for the Learn and Deliver
apps. Owns one artifact: flw-training-guide.md.

#### training-quick-reference
Generate the one-page printable pocket-card summary for FLWs in the
field. Owns one artifact: quick-reference.md.

#### training-faq
Generate anticipated LLO + FLW questions with authoritative answers.
Owns one artifact: faq.md.

#### training-deck-outline
Generate the slide-by-slide markdown outline that training-deck-build
renders into a Google Slides deck. Owns one artifact.

#### training-deck-build
Render training-deck-outline.md into a Google Slides deck using the
ACE template. Produces a presentable Slides URL.

#### training-onboarding-email
Generate the LLO onboarding email body, consumed by llo-onboarding
and personalized per LLO at send time. Owns one artifact.

#### connect-baseline-screenshots (cross-opp, manual)
Capture the per-Connect-version baseline of "how Connect works"
screenshots reused across every training deck. Manual, cross-opp.

---

## Phase 6: Solicitation Management

**Agent:** `solicitation-management`

> Phase 6 of the CRISPR-Connect lifecycle: publish a solicitation derived
> from the PDD, invite PDD-named candidate LLOs to it by email, and stop.
> The review-and-award lifecycle continues via the manually-invoked
> `solicitation-review` skill (gated on a human-in-the-loop checkpoint
> before `award_response` is called). Phase 7 starts once an awardee is
> recorded in `opp.yaml.selected_llo`.

### Skills

#### solicitation-create
Translate the PDD into a solicitation payload, derive evaluation criteria,
and publish via connect-labs MCP. Captures solicitation_id.

#### solicitation-create-eval
Grade a published solicitation against its source PDD — scope fidelity,
field completeness, deadline sensibility.

#### llo-invite
Email each PDD-named candidate LLO the public solicitation URL. No-op
when PDD has no preferred_llos.

#### solicitation-monitor (recurring)
Recurring poll for solicitation responses. Modes: --quick (count only) /
--monitor (full pull, default) / --close (final pull).

#### solicitation-review (manual; HALT-and-resume)
Score solicitation responses, recommend an awardee, and (after HITL
approval) call award_response and populate opp.yaml.selected_llo.

#### solicitation-review-eval
Compare ACE's top-ranked solicitation recommendation against the human's
actual award. Detection-rate metric.

---

## Phase 7: Execution Management

**Agent:** `execution-manager`

> Phase 7 of the CRISPR-Connect lifecycle: execute the awarded LLO's run
> of the opportunity — onboarding, UAT, go-live, and recurring monitoring.
> Phase 7 entry is gated on `opp.yaml.selected_llo.org_slug` being
> populated by Phase 6's `solicitation-review` skill.

### Skills

#### llo-onboarding
Issue the Connect program invite and send the awarded LLO the ACE
onboarding email with training materials and OCS widget link.

#### llo-uat
Coordinate User Acceptance Testing with onboarded LLOs. Send UAT
instructions, monitor feedback, compile results with sign-off status.

#### llo-launch
Activate the opportunity for live use. Verifies UAT sign-offs and
deep-QA verdicts, activates in Connect, notifies LLOs of go-live.

#### llo-launch-eval
Grade an llo-launch activation against PDD launch preconditions — UAT
sign-off, Connect activation, app-publish, go-live notify.

#### timeline-monitor (recurring)
Watch whether LLOs are hitting expected milestones on schedule. Email
prompts when behind. Recurring during active opp.

#### flw-data-review (recurring)
Analyze FLW submissions to identify quality issues, trends, and
improvement opportunities. Recurring during active opp.

#### flw-data-review-eval
Grade an flw-data-review report — signal coverage, outlier rigor,
recommendation actionability, evidence citation, trajectory awareness.

#### ocs-chatbot-qa --monitor (recurring)
See Phase 4. Phase 7 invokes recurring `--monitor` mode.

#### ocs-chatbot-eval --monitor (recurring)
See Phase 4. Phase 7 invokes recurring `--monitor` mode.

---

## Phase 8: Closeout

**Agent:** `closeout`

> Orchestrates opportunity closeout: invoice processing, LLO feedback
> collection, learnings summary, and overall cycle grading. Triggered
> when the opportunity reaches its end date.

### Skills

#### opp-closeout
Pull invoices from the completed opportunity and create a Jira ticket to
issue payment to the LLO.

#### llo-feedback
Prompt LLOs for feedback on application, process, and next-step
suggestions. Collect and document responses for closeout.

#### learnings-summary
Synthesize learnings from a completed opportunity. Drafts a new PDD to
seed the next cycle when iteration is warranted.

#### cycle-grade
Grade the closed CRISPR-Connect cycle end-to-end with concrete
improvement recommendations for the next cycle.

#### cycle-grade-eval
Independently re-grade a closed cycle's cycle-grade output. Detects
self-eval inflation, missing learnings, vague recommendations.

---

## Cross-cutting Skills

#### opp-eval (umbrella aggregator)
Umbrella aggregator that rolls every per-skill -eval verdict into a
run-level scorecard. Modes: --quick / --deep / --monitor.

#### eval-calibration (methodology reference)
Methodology reference for calibrating ACE's per-skill -eval rubrics —
ground-truth catalogues, variance protocol, detection-rate metric.

#### email-communicator (utility, called by other skills)
Send/receive email via GOG CLI using the ACE Gmail account. Utility
skill — other skills delegate here for any Gmail operation.

#### upload-transcript (utility)
Upload a Claude CLI stream-json transcript (.jsonl) to a deployed
ace-web via /api/ingest/upload. Used by /ace:run --ace-web-url.

---

## External Integrations

### Connect API
ACE talks to Connect through **two** MCP servers, scoped to distinct
domains:

1. **`connect-labs`** (lives in [`connect-labs` repo](https://github.com/dimagi/connect-labs))
   — solicitations, reviews, awards, funds. Production-ready and
   unrelated to the Programs/Opportunities lifecycle ACE manages.
   Consumed via a thin local stdio proxy (`mcp/connect-labs-server.ts`)
   that forwards JSON-RPC frames to the remote HTTP MCP at
   `https://labs.connect.dimagi.com/mcp/`.
2. **`ace-connect`** — composite Connect backend over `connect.dimagi.com`,
   authenticated as `ace@dimagi-ai.com` via OAuth-with-CommCareHQ. 21
   atoms today: 8 authoring atoms route to the REST automation API
   (commcare-connect#1135); the rest still drive HTML form pages via
   Playwright.

See `playbook/integrations/connect-api.md` for the atom inventory.

### CommCare API
Production-ready CommCare HQ tools live in the `connect-labs` MCP
(`list_apps`, `get_app_structure`, etc.). ACE calls them for app
inspection during Phase 2.

See `playbook/integrations/commcare-api.md`.

### OCS (Open Chat Studio)
Composite MCP backend with **22 atomic capabilities** at
`mcp/ocs-server.ts` → `ace-ocs`. REST + Playwright + composite backends.
Authenticate with `/ace:ocs-login` before calling tools that hit live OCS.

See `playbook/integrations/ocs-integration.md`.

### Nova (CommCare app builder)
Live as a sibling Claude Code plugin (`voidcraft-labs/nova-marketplace`).
End-to-end smoke test passed 2026-04-28. ACE consumes Nova's
`/nova:autobuild` slash command via the Nova plugin; OAuth on first use.

See `playbook/integrations/nova-integration.md`.

### Mobile (CommCare Android emulation)
The `ace-mobile` MCP server drives a local Android AVD on the operator's
Mac via Maestro + adb + Playwright. **Mac-only, dev-machine-only** — no
cloud device farms. Bootstrap with `/ace:mobile-bootstrap`.

See `playbook/integrations/mobile-integration.md`.

### Slides (Google Slides API)
Slides atoms (`slides_get`, `slides_batch_update`, `slides_copy_template`)
shipped 0.10.78. Back the `training-deck-build` skill, which renders
markdown deck-outlines into editable Google Slides decks.

See `playbook/integrations/slides-integration.md`.

---

## Current Limitations

`## Current Workaround` blocks across SKILL.md files document HITL
fallbacks for capabilities not yet automated. As of 0.13.43, no skills
ship with active workaround blocks — all previously-blocked Phase 3 / 5 /
7 paths are atom-driven via the `ace-connect` MCP (since 0.10.47).

The `commcare-form-patch` and `app-multimedia-coverage` skills ARE
documented workarounds but for the Nova upstream, not for Connect/CCHQ.
Both have explicit `## Removal criteria` sections naming the upstream
ticket whose resolution will retire the skill.

---

## Skill Reference

54 ACE skills + 3 reference docs. All skills ship with
`disable-model-invocation: true` (orchestrator-dispatched, never
free-text invoked). See `skills/README.md` for the author contract.

| Skill | Phase | Description (≤200 chars) |
|---|---|---|
| app-connect-coverage | 2 | Verify every form in a Nova-built Learn or Deliver app has the right CommCare Connect markers, auto-fix via Nova edits, loop until clean. |
| app-deploy | 2 | Upload Nova-built Learn + Deliver apps to CommCare HQ as draft builds via /nova:upload_to_hq. Captures HQ app IDs and writes a deploy summary. |
| app-multimedia-coverage | 2 (manual) | Attach display-only images to Connect app questions where they meaningfully help FLWs. Manual gate; not part of /ace:run. |
| app-release | 2 | Build and release the Learn + Deliver CommCare apps on CCHQ so Connect can read their form schema and surface deliver units. |
| app-release-eval | 2 | Verify every Learn + Deliver build was actually released so Connect can read deliver units. Provisional rubric pending 3+ real releases. |
| app-screenshot-capture | 5 | Run app smoke recipes against a local AVD and capture per-step screenshots for the training deck. Per-opp content only. |
| app-test-cases | 2 | Bind each PDD user journey to the Nova-built app structure and emit a Maestro recipe per journey with real selectors. Use after Nova finishes building, before app-release. |
| app-ux-eval | 5 (deep) | Grade the FLW experience of the built apps via LLM-as-Judge over captured screenshots. Deep-only — runs from /ace:qa-deep. |
| commcare-form-patch | 2 (workaround) | Apply surgical CCHQ form-XML patches when Nova's compile_app emits output Connect rejects, then re-build + re-release. Workaround skill. |
| connect-baseline-screenshots | xcut | Capture the per-Connect-version baseline of "how Connect works" screenshots reused across every training deck. Manual, cross-opp. |
| connect-opp-setup | 3 | Create and fully configure a Connect Opportunity — opp shell, verification flags, payment units, ACE test-user pre-invite for emulator testing. |
| connect-program-setup | 3 | Create or reuse a Connect Program for the opportunity, archetype-matched to the PDD. Captures program_id for downstream skills. |
| connect-program-setup-eval | 3 | Grade Connect Program + Opportunity configuration against the PDD — reuse-vs-create, verification rules, delivery units, payment units. |
| cycle-grade | 8 | Grade the closed CRISPR-Connect cycle end-to-end with concrete improvement recommendations for the next cycle. |
| cycle-grade-eval | 8 | Independently re-grade a closed cycle's cycle-grade output. Detects self-eval inflation, missing learnings, vague recommendations. |
| email-communicator | xcut | Send/receive email via GOG CLI using the ACE Gmail account. Utility skill — other skills delegate here for any Gmail operation. |
| eval-calibration | xcut | Methodology reference for calibrating ACE's per-skill -eval rubrics — ground-truth catalogues, variance protocol, detection-rate metric. |
| flw-data-review | 7 | Analyze FLW submissions to identify quality issues, trends, and improvement opportunities. Recurring during active opp. |
| flw-data-review-eval | 7 | Grade an flw-data-review report — signal coverage, outlier rigor, recommendation actionability, evidence citation, trajectory awareness. |
| idea-to-pdd | 1 | Develop a Program Design Doc (PDD) for a Connect intervention from source material. Iterates a 5-question stress-test rubric until approved. |
| idea-to-pdd-eval | 1 | Independently grade a PDD against the source idea pack — re-runs the stress test from outside and cross-checks reviewer-comment fidelity. |
| learnings-summary | 8 | Synthesize learnings from a completed opportunity. Drafts a new PDD to seed the next cycle when iteration is warranted. |
| llo-feedback | 8 | Prompt LLOs for feedback on application, process, and next-step suggestions. Collect and document responses for closeout. |
| llo-invite | 6 | Email each PDD-named candidate LLO the public solicitation URL. No-op when PDD has no preferred_llos. |
| llo-launch | 7 | Activate the opportunity for live use. Verifies UAT sign-offs and deep-QA verdicts, activates in Connect, notifies LLOs of go-live. |
| llo-launch-eval | 7 | Grade an llo-launch activation against PDD launch preconditions — UAT sign-off, Connect activation, app-publish, go-live notify. |
| llo-onboarding | 7 | Issue the Connect program invite and send the awarded LLO the ACE onboarding email with training materials and OCS widget link. |
| llo-uat | 7 | Coordinate User Acceptance Testing with onboarded LLOs. Send UAT instructions, monitor feedback, compile results with sign-off status. |
| ocs-agent-setup | 4 | Clone the ACE OCS template into a per-opp chatbot, attach a RAG collection from PDD + training + app summaries, publish, return embed credentials. |
| ocs-chatbot-eval | 4, 7 | LLM-as-Judge grader for OCS chatbot transcripts. Modes: --quick (1-dim smoke), --deep / --monitor (5-dim calibrated; emits gate brief). |
| ocs-chatbot-qa | 4, 7 | Exercise the per-opp OCS chatbot via its anonymous widget and capture a transcript with structural checks. Modes: --quick / --deep / --monitor. |
| ocs-widget-handoff-eval | 4 | Grade the OCS widget-handoff staging artifact for HITL paste-in — widget URL, embed key, opportunity-binding instructions. |
| opp-closeout | 8 | Pull invoices from the completed opportunity and create a Jira ticket to issue payment to the LLO. |
| opp-eval | xcut | Umbrella aggregator that rolls every per-skill -eval verdict into a run-level scorecard. Modes: --quick / --deep / --monitor. |
| pdd-to-app-journeys | 1 | Derive opp-specific expected user journeys from an approved PDD. Produces the UX-intent ground truth consumed by app-test-cases and app-ux-eval. |
| pdd-to-deliver-app | 2 | Build the CommCare Deliver (service-delivery) app from the PDD via Nova's /nova:autobuild. Captures nova_app_id and writes a structure summary. |
| pdd-to-deliver-app-eval | 2 | Grade a Nova-built Deliver app against the PDD that specified it — field count, ordering, conditional logic, Connectify wiring. |
| pdd-to-learn-app | 2 | Build the CommCare Learn (training) app from the PDD via Nova's /nova:autobuild. Captures nova_app_id and writes a structure summary. |
| pdd-to-learn-app-eval | 2 | Grade a Nova-built Learn app against the PDD that specified it — module count, order, Assessment Score wiring, content coverage. |
| pdd-to-test-prompts | 1 | Derive opp-specific Q&A test prompts from an approved PDD. Produces the ground-truth suite for the Phase 4 OCS chatbot deep gate. |
| solicitation-create | 6 | Translate the PDD into a solicitation payload, derive evaluation criteria, and publish via connect-labs MCP. Captures solicitation_id. |
| solicitation-create-eval | 6 | Grade a published solicitation against its source PDD — scope fidelity, field completeness, deadline sensibility. |
| solicitation-monitor | 6 | Recurring poll for solicitation responses. Modes: --quick (count only) / --monitor (full pull, default) / --close (final pull). |
| solicitation-review | 6 (manual) | Score solicitation responses, recommend an awardee, and (after HITL approval) call award_response and populate opp.yaml.selected_llo. |
| solicitation-review-eval | 6 | Compare ACE's top-ranked solicitation recommendation against the human's actual award. Detection-rate metric. |
| timeline-monitor | 7 | Watch whether LLOs are hitting expected milestones on schedule. Email prompts when behind. Recurring during active opp. |
| training-deck-build | 5 | Render training-deck-outline.md into a Google Slides deck using the ACE template. Produces a presentable Slides URL. |
| training-deck-outline | 5 | Generate the slide-by-slide markdown outline that training-deck-build renders into a Google Slides deck. Owns one artifact. |
| training-faq | 5 | Generate anticipated LLO + FLW questions with authoritative answers. Owns one artifact: faq.md. |
| training-flw-guide | 5 | Generate the FLW-facing step-by-step guide for the Learn and Deliver apps. Owns one artifact: flw-training-guide.md. |
| training-llo-guide | 5 | Generate the LLO-facing operations document for overseeing FLW deployment. Owns one artifact: llo-manager-guide.md. |
| training-onboarding-email | 5 | Generate the LLO onboarding email body, consumed by llo-onboarding and personalized per LLO at send time. Owns one artifact. |
| training-quick-reference | 5 | Generate the one-page printable pocket-card summary for FLWs in the field. Owns one artifact: quick-reference.md. |
| upload-transcript | xcut | Upload a Claude CLI stream-json transcript (.jsonl) to a deployed ace-web via /api/ingest/upload. Used by /ace:run --ace-web-url. |

### Reference docs (`skills/_*-template.md`)

Three reference documents extract shared boilerplate so skills don't
duplicate it. Excluded from the skill catalog because filenames start
with `_`.

- `_eval-template.md` — verdict YAML contract, severity rules, inflation
  guard, stock blocks for `## MCP Tools Used / ## Mode Behavior /
  ## Dry-Run Behavior`. Referenced by all 12 `*-eval` skills.
- `_training-template.md` — per-artifact decomposition rationale, sibling
  map, common Drive paths. Referenced by the 7 `training-*` skills.
- `_solicitation-template.md` — `opp.yaml.solicitation` and
  `opp.yaml.selected_llo` contract, connect-labs MCP atom inventory,
  Phase 6 → Phase 7 boundary rule. Referenced by all 5 solicitation
  skills + `llo-invite`.
