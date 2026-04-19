# ACE Playbook — CRISPR-Connect Process

_Generated: 2026-04-14 (ACE 0.2.0 — 6-phase orchestration)_

Derived from `agents/*.md`, `skills/*/SKILL.md`, and
`playbook/integrations/*.md`. Regenerate with `/ace:docs` after changing any
of those sources.

## Overview

ACE (AI Connect Engine) orchestrates the full CRISPR-Connect lifecycle for a
Connect opportunity. The `ace-orchestrator` agent dispatches to six phase
agents in order. Phases 1–4 are "setup" and run end-to-end with **zero LLO
involvement** — an operator reviews the fully configured opportunity before
any outside contact. Phase 5 is the first LLO-facing phase. Phase 6 closes
out the opportunity after it ends.

Two execution modes:

- **Auto** — run all phases sequentially, email the CRISPR Admin group at
  each step completion, log gates but don't enforce them.
- **Review** — same flow, but pause at gate steps and use AskUserQuestion
  to get operator approval. Gate steps:
  - After `idea-to-pdd` (Phase 1) — PDD must be approved
  - After `app-deploy` (Phase 2) — apps must be verified before Connect setup
  - After `llo-invite` (Phase 3) — invite list must be approved
  - After `ocs-chatbot-eval --deep` (Phase 4) — OCS quality must clear
    the pre-launch bar (eval grades the transcript captured by
    `ocs-chatbot-qa --deep`)
  - After `llo-launch` (Phase 5) — opportunity activation must be verified

Two safety flags:

- `--dry-run` — effectful skills (emails, publishes, tickets, external APIs)
  write their intended actions to `ACE/<opp-name>/comms-log/dry-run-<step>.md`
  instead of executing. Gates still apply in review mode. `state.yaml` tracks
  steps as `dry-run-success` / `dry-run-blocked`.
- `--sandbox` — MCP servers route external calls to staging endpoints via
  the `ACE_SANDBOX` env var. Combinable with `--dry-run`.

## Process Flow

```
Phase 1  design-review        idea-to-pdd ──► pdd-to-test-prompts
             │
             │ gate: PDD approved
             ▼
Phase 2  commcare-setup       pdd-to-learn-app ∥ pdd-to-deliver-app
                              ──► app-deploy ──► app-test ∥ training-materials
             │
             │ gate: apps verified
             ▼
Phase 3  connect-setup        connect-program-setup ──► connect-opp-setup
                              ──► llo-invite (prepared only)
             │
             │ gate: invite list approved
             ▼
Phase 4  ocs-setup            ocs-agent-setup
                              ──► ocs-chatbot-qa --quick ──► ocs-chatbot-eval --quick   (smoke gate)
                              ──► ocs-chatbot-qa --deep  ──► ocs-chatbot-eval --deep    (pre-launch gate)
                              ──► widget-handoff to Connect
             │
             │ gate: deep eval pass
             ▼
Phase 5  llo-manager          llo-onboarding (invite + widget-linked email)
                              ──► llo-uat ──► llo-launch
                              ──► (recurring) timeline-monitor ∥ flw-data-review
                                              ∥ ocs-chatbot-qa --monitor
                                              ──► ocs-chatbot-eval --monitor
             │
             │ gate: launch approved
             │ ... opportunity runs ...
             ▼
Phase 6  closeout             opp-closeout ──► llo-feedback
                              ──► learnings-summary ──► cycle-grade
```

## Phase 1 — Design Review & Iteration

**Agent:** `design-review`

Turn an initial idea into an approved PDD and derive the opp-specific test
prompt suite that Phase 4's deep QA gate will use as ground truth.

### Step 1 — `idea-to-pdd`

Iterate on an idea to produce a well-specified Program Design Doc (PDD)
that defines the intervention, target FLWs, visit structure, and preferred
LLOs.

- **Input:** `ACE/<opp-name>/idea.md`
- **Output:** `ACE/<opp-name>/pdd.md`
- **Gate (review mode):** operator approval of the PDD
- **LLM-as-Judge:** PDD quality (completeness, feasibility, clarity)

### Step 2 — `pdd-to-test-prompts`

Derive 20+ Q&A pairs from the PDD covering intervention basics, FLW visit
flow, eligibility edge cases, data-quality rules, escalation triggers,
expected `[product-feedback]` / `[training-gap]` paths, and a handful of
out-of-scope questions.

- **Input:** `ACE/<opp-name>/pdd.md`
- **Output:** `ACE/<opp-name>/test-prompts.md` — each entry has a question,
  expected-answer summary, expected tags, and expected escalation. This is
  the ground truth that `ocs-chatbot-eval --deep` grades responses against
  (after `ocs-chatbot-qa --deep` captures the transcript)
- **Self-check:** at least one prompt per PDD section + edge-case coverage

## Phase 2 — CommCare Setup

**Agent:** `commcare-setup`

Translate the approved PDD into Learn and Deliver apps via Nova, deploy to
CommCare HQ, test, and generate training materials.

### Step 1 — `pdd-to-learn-app` ∥ `pdd-to-deliver-app` (parallel)

Pass the PDD to Nova to generate the Learn (data collection) and Deliver
(service delivery) apps. Nova asks configuration questions; both skills
answer them from the PDD and output the app CCZ/JSON + a structure summary.

- **Input:** `ACE/<opp-name>/pdd.md`
- **Output:** `apps/learn-app.json`, `apps/deliver-app.json`,
  `app-summaries/learn-app-summary.md`,
  `app-summaries/deliver-app-summary.md`
- **LLM-as-Judge:** app quality vs. PDD requirements
- **Current Workaround:** Nova MCP doesn't exist yet — see
  `playbook/integrations/nova-integration.md`. Skills currently guide an
  operator through a Nova chat session

### Step 2 — `app-deploy`

Upload both apps to the CRISPR-Connect domain on CommCare HQ, build, and
publish.

- **Input:** `apps/*.json` from GDrive
- **Output:** `deployment-summary.md` with IDs, URLs, build status
- **Gate (review mode):** operator verifies the deployment
- **Current Workaround:** CommCare MCP lives in `connect-labs` — see
  `playbook/integrations/commcare-api.md`. Skill prompts operator through
  the CCHQ admin UI

### Step 3 — `app-test` ∥ `training-materials` (parallel)

- **`app-test`** — create an automated test plan cross-referenced against
  the PDD's Evidence Model, execute it, and log bugs.
  Output: `test-results/test-plan.md`, `test-results.md`, `bugs.md`.
- **`training-materials`** — generate LLO Manager guide, FLW training
  guide, quick-reference card, and FAQ from the app summaries + standard
  templates. Output: `training-materials/*.md`.
- **LLM-as-Judge:** both skills self-evaluate quality.

## Phase 3 — Connect Setup

**Agent:** `connect-setup`

Set up the Connect platform for the opportunity. Invite list is **prepared
only** here; the actual send happens in Phase 5 after the OCS widget is
configured.

### Step 1 — `connect-program-setup`

Create or select a Connect Program. Checks whether an existing program fits
before creating a new one.

- **Input:** PDD + opportunity details
- **Output:** `connect-setup/program.md`
- **Current Workaround:** `create_program`/`update_program` not built
  (CCC-301). Skill presents config values and prompts operator to
  create via Connect admin UI

### Step 2 — `connect-opp-setup`

Create the Connect Opportunity with verification rules, delivery units, and
payment units.

- **Input:** Program ID + PDD + deployment summary
- **Output:** `connect-setup/opportunity.md`
- **Current Workaround:** `create_opportunity`/`update_opportunity` not
  built (CCC-301). Manual operator flow

### Step 3 — `llo-invite` (prepare only)

Identify candidate LLOs from the PDD's preferences and the LLO Directory,
prepare the invite list with rationale per LLO.

- **Input:** Opportunity ID + PDD's LLO preferences section
- **Output:** `connect-setup/invites.md` with status `prepared`
- **Gate (review mode):** operator approval of the list
- **Note:** sending moves to `llo-onboarding` in Phase 5 so the email can
  include the OCS widget link

## Phase 4 — OCS Setup

**Agent:** `ocs-setup`

Configure the per-opportunity OCS chatbot, quality-gate it, and hand the
widget credentials to the operator for the Connect opportunity. No LLOs
interact in this phase — only the ACE judge does.

### Step 1 — `ocs-agent-setup`

Clone the ACE golden template, create a per-opp RAG collection, upload
PDD + training + app summaries, wait for indexing, patch the opp-specific
system prompt, attach both the shared Connect collection and the opp
collection as knowledge sources, publish a version.

- **Input:** PDD, training materials, app summaries, opportunity config
- **Output:** `ocs-agent-config.md` with
  `{experiment_id, public_id, embed_key, collection_id, pipeline_id, version_number}`
- **MCP atoms:** `ocs_list_chatbots`, `ocs_clone_chatbot`,
  `ocs_create_collection`, `ocs_upload_collection_files`,
  `ocs_wait_for_collection_indexing`, `ocs_set_chatbot_system_prompt`,
  `ocs_attach_knowledge`, `ocs_publish_chatbot_version`,
  `ocs_get_chatbot_embed_info`
- **Idempotency:** resumes from existing `ocs-agent-config.md` if present
- **Review mode:** pauses to show composed prompt + file list, and again
  before publishing

### Step 2 — `ocs-chatbot-qa --quick` → `ocs-chatbot-eval --quick`

qa captures a 5-question smoke suite (escalation, tagging,
shared-collection retrieval, graceful-decline) with structural checks to
fast-fail a miswired bot. eval then grades the transcript. Stdout summary
only.

- **Gate:** qa structural pass rate = 100% AND eval overall ≥ 7. On fail:
  one prompt-patch retry, then escalate

### Step 3 — `ocs-chatbot-qa --deep` → `ocs-chatbot-eval --deep`

qa captures the full suite: Connect-general + ACE-specific + opp-specific
(from `test-prompts.md`) + edge-case extras (out-of-scope, adversarial,
multi-turn, non-English if applicable) at
`qa-captures/YYYY-MM-DD-ocs-chat-deep.md`. eval grades each response.

- **Outputs:** `verdicts/ocs-chatbot-eval-deep.yaml` (machine),
  `eval-reports/YYYY-MM-DD-ocs-eval.md` (human), `gate-briefs/ocs-chatbot-eval-deep.md`
- **Judge dimensions (eval skill):** Correctness (40%) · Source usage (20%)
  · Tone (20%) · Tagging (20%); per-prompt Pass/Warn/Fail
- **Gate (review mode):** overall ≥ 7 AND every Fail resolved

### Step 4 — Widget handoff to Connect

Present `{public_id, embed_key}` with exact paste instructions.

- **Output:** `ocs-setup/widget-handoff.md`
- **Current Workaround:** Connect `update_opportunity` API unbuilt
  (CCC-301). Operator pastes creds into Connect admin UI. Becomes a single
  API call when CCC-301 lands

## Phase 5 — LLO Management

**Agent:** `llo-manager`

First LLO-facing phase. Sends Connect invites and the ACE onboarding email
(with widget link), runs UAT, activates the opportunity, and keeps
recurring monitoring skills running for the life of the opportunity.

### Step 1 — `llo-onboarding`

Issue the Connect system invite for each `prepared` entry and send the
ACE-authored onboarding email from `ace@dimagi-ai.com` with training
materials, getting-started instructions, and the **OCS widget link**
derived from `public_id` + `embed_key`.

- **Input:** `invites.md` (prepared), `training-materials/`,
  `ocs-agent-config.md`
- **Output:** `comms-log/onboarding-emails.md`; invite statuses flipped to
  `sent`
- **Current Workaround:** Connect `send_invite` not built — operator sends
  via UI, ACE confirms and flips status

### Step 2 — `llo-uat`

Coordinate UAT with onboarded LLOs. Monitor OCS transcripts for issues
during the UAT window (real LLO usage here is itself QA signal on top of
the Phase 4 judge).

- **Output:** `uat/uat-results.md` with per-LLO sign-off status

### Step 3 — `llo-launch`

Verify UAT sign-offs, activate the opportunity in Connect, confirm apps are
published, notify LLOs of go-live.

- **Output:** `launch/launch-record.md`
- **Gate (review mode):** operator approval of launch readiness

### Step 4 — Ongoing monitoring (recurring)

Scheduled during the active opportunity until end date:

- **`timeline-monitor`** (weekly) — checks LLO progress against milestones,
  sends prompting emails if behind. Writes
  `monitoring/YYYY-MM-DD-timeline-check.md`
- **`flw-data-review`** (weekly) — analyzes FLW submission quality (Layer
  B per-delivery + Layer C cross-delivery), produces recommendations.
  Writes `data-reviews/YYYY-MM-DD-review.md`
- **`ocs-chatbot-qa --monitor` → `ocs-chatbot-eval --monitor`** (weekly) —
  qa captures a periodic full-suite transcript against the live bot to
  catch retrieval drift (e.g. after the shared Connect collection
  auto-syncs new Confluence pages); eval grades it. qa writes
  `qa-captures/YYYY-MM-DD-ocs-chat-monitor.md`; eval writes
  `verdicts/ocs-chatbot-eval-monitor.yaml`, `eval-reports/YYYY-MM-DD-ocs-eval.md`,
  and appends a trend entry to `eval-reports/trend.md`. eval emails the
  admin group if overall score drops by more than 1.5 points run-to-run

## Phase 6 — Closeout

**Agent:** `closeout`

Triggered when the opportunity reaches its end date.

### Step 1 — `opp-closeout`

Pull invoices from Connect, create a Jira ticket to issue payment.

- **Output:** `closeout/invoices.md`
- **Current Workaround:** Connect `list_invoices`/`get_invoice` not built.
  Manual pull + ticket draft

### Step 2 — `llo-feedback`

Prompt LLOs for feedback, collect and document responses.

- **Output:** `closeout/llo-feedback.md`
- **Current Workaround:** draft email + operator send

### Step 3 — `learnings-summary`

Synthesize feedback, data reviews, monitoring reports, and OCS transcripts
into process/content/technical/relationship learnings against the original
PDD. Optionally produces a new PDD if iteration is warranted.

- **Output:** `closeout/learnings.md` (+ optional `closeout/new-pdd.md`)

### Step 4 — `cycle-grade`

Final 6/7-dimension grade with evidence and recommendations. Uses the
PDD's `archetype:` field and `## Evidence Model` section to determine
which rubric to apply.

- **Output:** `closeout/cycle-grade.md`
- **LLM-as-Judge:** self-evaluates grading quality

## External Integrations

### Connect API (`playbook/integrations/connect-api.md`)

Lives in the `connect-labs` repo (separate plugin). ~20 production tools
available today for Solicitations, Reviews, Awards, Funds, and Opportunity
Lookup. **Unbuilt and blocking:** Program/Opportunity CRUD
(`create_program`, `create_opportunity`, `update_opportunity`),
verification-rule / delivery-unit / payment-unit configuration, invite API
(`send_llo_invite`), invoice API (`list_invoices`, `get_invoice`). Tracked
under CCC-301. Staging URL TBD.

### CommCare API (`playbook/integrations/commcare-api.md`)

Also lives in `connect-labs`. Used by `app-deploy` for CCHQ upload / build /
publish. Most Phase 2 skills degrade to operator-assisted workflows until
the MCP is installed alongside ACE.

### OCS (`playbook/integrations/ocs-integration.md`)

`ace-ocs` MCP is wired via `.mcp.json` and under active buildout. ~22
atomic capabilities routed through a composite backend (REST + Playwright
+ pipeline-patch). Authenticate with `/ace:ocs-login` before any live
call. Bootstrap the golden template once per environment with
`/ace:ocs-bootstrap-template`.

### Nova (`playbook/integrations/nova-integration.md`)

Nova MCP does **not exist yet**. `pdd-to-learn-app` and `pdd-to-deliver-app`
currently guide operators through a Nova chat session manually.

## Current Limitations (by skill)

| Skill | Limitation |
|---|---|
| `app-deploy` | CommCare MCP in separate repo; operator-assisted |
| `connect-program-setup` | `create_program` unbuilt (CCC-301) |
| `connect-opp-setup` | `create_opportunity`/`update_opportunity` unbuilt |
| `pdd-to-learn-app` | Nova MCP doesn't exist |
| `pdd-to-deliver-app` | Nova MCP doesn't exist |
| `llo-invite` | `list_llo_contacts` unbuilt; list-only in Phase 3 |
| `llo-onboarding` | Connect `send_invite` unbuilt; operator-assisted |
| `llo-uat`, `llo-launch` | Depend on unbuilt Connect opportunity APIs |
| `llo-feedback` | Draft-only; operator sends |
| `opp-closeout` | Connect invoice API unbuilt |
| `ocs-setup` widget handoff | Connect `update_opportunity` unbuilt — manual paste |

## Skill Reference

| Skill | Phase | Description |
|---|---|---|
| `idea-to-pdd` | 1 | Iterate an idea into an PDD |
| `pdd-to-test-prompts` | 1 | Derive opp-specific test Q&A pairs from PDD |
| `pdd-to-learn-app` | 2 | Generate Learn app via Nova |
| `pdd-to-deliver-app` | 2 | Generate Deliver app via Nova |
| `app-deploy` | 2 | Upload + publish apps to CCHQ |
| `app-test` | 2 | Automated test plan execution vs. Evidence Model |
| `training-materials` | 2 | LLO/FLW training docs from app summaries |
| `connect-program-setup` | 3 | Create/select Connect Program |
| `connect-opp-setup` | 3 | Create Connect Opportunity + config |
| `llo-invite` | 3 | Prepare LLO invite list (no send) |
| `ocs-agent-setup` | 4 | Clone golden template, RAG, prompt, publish |
| `ocs-chatbot-qa` | 4, 5 | Capture: `--quick` smoke · `--deep` pre-launch · `--monitor` recurring (transcript → `qa-captures/`) |
| `ocs-chatbot-eval` | 4, 5 | Judge: LLM-as-Judge on captured transcript; writes `verdicts/` + `eval-reports/` + Phase 4 gate brief |
| `llo-onboarding` | 5 | Send Connect invites + onboarding email w/ widget |
| `llo-uat` | 5 | Coordinate LLO user-acceptance testing |
| `llo-launch` | 5 | Activate opportunity, notify go-live |
| `timeline-monitor` | 5 | Weekly milestone check |
| `flw-data-review` | 5 | Weekly FLW submission quality review |
| `opp-closeout` | 6 | Invoice pull + Jira payment ticket |
| `llo-feedback` | 6 | Collect closeout feedback |
| `learnings-summary` | 6 | Synthesize learnings; optional new PDD |
| `cycle-grade` | 6 | Final grade + recommendations |
| `opp-eval` | ad-hoc (umbrella) | Aggregate every `verdicts/*.yaml` into a run-level scorecard across 6 skill-category dimensions; three modes (`--quick` structural check · `--deep` aggregation + recommendations · `--monitor` same as deep + trend-file append). Not part of the 6-phase pipeline; invoke via `/ace:eval` |
| `email-communicator` | utility | GOG-CLI Gmail send/receive for other skills |
