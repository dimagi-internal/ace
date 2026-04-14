# ACE Playbook — CRISPR-Connect Process

Generated: 2026-04-14

> This document is auto-generated from `agents/*.md`, `skills/*/SKILL.md`, and
> `playbook/integrations/*.md` via `/ace:docs`. Do not edit by hand — your
> changes will be lost on the next regeneration.

## Overview

ACE (AI Connect Engine) orchestrates the full CRISPR-Connect lifecycle for
Connect opportunities — from idea iteration through app building, deployment,
LLO management, and closeout. Opportunity state lives in Google Drive under
`ACE/<opp-name>/` and is tracked by `state.yaml`.

ACE supports two execution modes:

- **Auto mode** — runs all phases sequentially and emails the CRISPR Admin
  group at each step. Gates are logged but not enforced.
- **Review mode** — runs all phases sequentially but pauses at gate steps to
  solicit human approval before proceeding.

Two additional flags can be combined with either mode:

- **`--dry-run`** — effectful skills (email, app publish, Jira ticket creation,
  external API calls) write their intended actions to
  `comms-log/dry-run-<step>.md` instead of executing. Outputs written to GDrive
  still happen; LLM-as-Judge evaluation still runs.
- **`--sandbox`** — MCP servers route external API calls to staging endpoints
  (Connect staging, CommCare staging project space) based on `ACE_SANDBOX=true`.

## Process Flow

| # | Phase | Skill | Gate (review mode) | Depends on |
|---|-------|-------|--------------------|------------|
| 1 | Build | `idea-to-idd` | IDD approval | — |
| 2a | Build | `idd-to-learn-app` | — | 1 |
| 2b | Build | `idd-to-deliver-app` | — | 1 |
| 3 | Build | `app-deploy` | deployment verification | 2a, 2b |
| 4a | Build | `app-test` | — | 3 |
| 4b | Build | `training-materials` | — | 2a, 2b |
| 5 | Setup | `connect-program-setup` | — | 1 |
| 6 | Setup | `connect-opp-setup` | — | 5, 3 |
| 7 | Setup | `llo-invite` | invite list approval | 6 |
| 8 | Operate | `llo-onboarding` | — | 7, 4b |
| 9 | Operate | `llo-uat` | — | 3, 4b, 6 |
| 10 | Operate | `llo-launch` | launch readiness | 9 |
| 11 | Operate | `ocs-agent-setup` | — | 1, 4b, 6 |
| — | Operate | `timeline-monitor` (recurring) | — | 10 |
| — | Operate | `flw-data-review` (recurring) | — | 10 |
| 12 | Closeout | `opp-closeout` | — | opportunity end date |
| 13 | Closeout | `llo-feedback` | — | 12 |
| 14 | Closeout | `learnings-summary` | — | 12, 13 |
| 15 | Closeout | `cycle-grade` | — | 14 |

Steps 2a/2b and 4a/4b run in parallel within their phase.

## Phase 1: App Building

### Agent: app-builder

Orchestrates the app building phase of CRISPR-Connect: idea iteration into an
IDD, passing the IDD to Nova for Learn and Deliver apps, deploying to CCHQ,
testing, and creating training materials.

### Skills

#### `idea-to-idd`
Iterate on an initial idea to produce a well-specified Intervention Design Doc
(IDD) including archetype, Evidence Model, and stress-test appendix. Declares
the delivery archetype (`atomic-visit`, `focus-group`, or `multi-stage`) which
shapes every downstream skill. Runs a 5-question stress-test rubric
(executability, verifiability, measurability, stage-gate clarity, resource
realism) and blocks output if ≥2 checks fail.
- **Output**: `idd.md`
- **Mode behavior**: auto writes IDD + emails admin group; review pauses for human approval.
- **LLM-as-Judge**: stress-test rubric with grading anchors.

#### `idd-to-learn-app`
Pass an IDD to Nova to generate the Learn app. For `atomic-visit` archetypes
the Learn app is a form-walkthrough data-collection trainer; for `focus-group`
it is a facilitation craft training app.
- **Output**: `apps/learn-app.json`, `app-summaries/learn-app-summary.md`
- **Current workaround**: Nova API does not exist yet — the skill produces a Nova brief and hands off to a human.

#### `idd-to-deliver-app`
Pass an IDD to Nova to generate the Deliver app. Delivery unit definition is
archetype-sensitive: `atomic-visit` = per-beneficiary visit; `focus-group` =
per-session documentation with segment-level case.
- **Output**: `apps/deliver-app.json`, `app-summaries/deliver-app-summary.md`
- **Current workaround**: same as `idd-to-learn-app` — Nova integration pending.

#### `app-deploy`
Upload Learn and Deliver app JSONs to the CRISPR-Connect domain on CommCare HQ,
build, and publish.
- **Output**: `deployment-summary.md`
- **Current workaround**: CommCare app upload API is not yet built — the skill produces manual upload instructions.

#### `app-test`
Create and execute an automated test plan against the deployed apps. Every
Layer A artifact from the IDD's Evidence Model must have a passing capture
test. Errors out if the Evidence Model is missing.
- **Output**: `test-results/test-plan.md`, `test-results.md`, `bugs.md`
- **LLM-as-Judge**: coverage + bug-triage self-eval.

#### `training-materials`
Generate LLO Manager Guide, FLW Training Guide, Quick Reference Card, and FAQ
from the app summaries and IDD.
- **Output**: `training-materials/{llo-manager-guide,flw-training-guide,quick-reference,faq}.md`
- **LLM-as-Judge**: clarity + coverage.

## Phase 2: Connect Setup

### Agent: connect-setup

Orchestrates Connect platform setup: program creation, opportunity
configuration, and LLO invitations. Before creating a Program, the
CRISPR-Connect workspace must be selected.

### Skills

#### `connect-program-setup`
Create or select a Connect program for this opportunity. Checks if an existing
program fits before creating a new one.
- **Output**: `connect-setup/program.md`
- **Current workaround**: `create_program` API does not exist yet (CCC-301).

#### `connect-opp-setup`
Create and fully configure the Connect Opportunity — verification rules
(Evidence Model Layer A → hard gates), delivery units (archetype-sensitive),
payment units. Errors out if the IDD has no Evidence Model section.
- **Output**: `connect-setup/opportunity.md`
- **Current workaround**: Opportunity CRUD and configuration APIs are blocked on CCC-301.

#### `llo-invite`
Look up LLO contacts from the LLO Directory and invite them to the Connect
opportunity. Gate step in review mode.
- **Output**: `connect-setup/invites.md`
- **Current workaround**: Connect invite API does not exist yet; skill produces a recommended invite list.

## Phase 3: LLO Management

### Agent: llo-manager

Orchestrates LLO management during an active opportunity: onboarding, UAT,
go-live, OCS agent setup, and recurring monitoring skills that run on schedule.

### Skills

#### `llo-onboarding`
Send onboarding emails to invited LLOs with training materials and instructions.
Uses `ace@dimagi-ai.com` as sender via the `email-communicator` skill.
- **Output**: `comms-log/onboarding-emails.md`
- **Current workaround**: historical entry where the skill drafted emails for a human to send; now uses GOG CLI via `email-communicator`.

#### `llo-uat`
Coordinate User Acceptance Testing with onboarded LLOs. Send UAT instructions,
monitor for feedback via OCS transcripts, and compile LLO sign-off results.
- **Output**: `uat/uat-results.md`

#### `llo-launch`
Activate the opportunity for live use. Verifies UAT sign-offs, activates in
Connect, confirms apps are published, and notifies LLOs. Gate step in review
mode.
- **Output**: `launch/launch-record.md`
- **Current workaround**: Connect activation API pending; skill asks user to activate via Connect UI.

#### `ocs-agent-setup`
Create and configure an OCS chatbot for this opportunity. Clones the ACE
golden template, uploads IDD + training + app summaries as a RAG Collection,
patches the system prompt with opp-specific framing, publishes a version, and
returns embed credentials for Connect. Idempotent — re-runs use the existing
chatbot if one already exists.
- **Output**: `ocs-agent-config.md`
- **LLM-as-Judge**: 3–5 canned questions via `ocs_send_test_message` compared against expected answers from the IDD.

#### `timeline-monitor` (recurring)
Check LLO progress against expected milestones. Uses OCS session data to detect
stuck, confused, or silent LLOs. Sends nudges via `ocs_trigger_bot_message`
(auto mode only) and prompting emails if behind schedule.
- **Output**: `monitoring/YYYY-MM-DD-timeline-check.md`

#### `flw-data-review` (recurring)
Analyze FLW submission data for quality issues, trends, and improvement
opportunities. For `atomic-visit` archetypes, runs quantitative review
(submission rates, outliers, caps). For `focus-group`, runs qualitative
synthesis (per-session quality, cross-session themes, saturation, quote bank).
Cross-references with OCS transcripts.
- **Output**: `data-reviews/YYYY-MM-DD-review.md`

## Phase 4: Closeout

### Agent: closeout

Triggered when the opportunity reaches its end date. Orchestrates invoice
processing, LLO feedback collection, learnings summary, and overall cycle
grading.

### Skills

#### `opp-closeout`
Pull invoices from Connect and create a Jira ticket to issue payment to the LLO.
- **Output**: `closeout/invoices.md`
- **Current workaround**: Connect invoice API pending; Jira ticket creation uses Atlassian MCP.

#### `llo-feedback`
Prompt LLOs for feedback about the app, process, and suggestions for next
steps. Monitor responses via OCS transcripts.
- **Output**: `closeout/llo-feedback.md`

#### `learnings-summary`
Synthesize all opportunity artifacts into process/content/technical/relationship
learnings. Drafts a new IDD for iteration if warranted.
- **Output**: `closeout/learnings.md`, optionally `closeout/new-idd.md`

#### `cycle-grade`
Final grade across 6 dimensions (Intervention Effectiveness, App Quality, LLO
Execution, FLW Performance, Process Efficiency, Communication Quality). For
`focus-group` archetypes, adds a 7th dimension (Research Quality) and uses
archetype-specific rubrics for FLW Performance and Intervention Effectiveness.
For `multi-stage`, grades stage-gate transitions.
- **Output**: `closeout/cycle-grade.md`
- **LLM-as-Judge**: self-evaluates grading quality against Evidence Model evidence.

## Support Skills

### `email-communicator`
Utility skill — send and receive email via GOG CLI using the ACE Gmail account
(`ace@dimagi-ai.com`). Other skills delegate to this for all email operations.
- **Operations**: send, reply, search, read
- **Uses GOG CLI, not MCP**

### `ocs-chatbot-qa`
Evaluate an ACE OCS chatbot's response quality by sending test prompts via the
anonymous widget endpoint and grading responses with LLM-as-Judge across 4
dimensions (correctness 40%, source usage 20%, tone 20%, tagging 20%).
- **Output**: console report or `qa-reports/YYYY-MM-DD-ocs-qa.md`
- **Invoked by**: the `ocs-tester` agent

## External Integrations

### Connect API (`connect-labs` MCP)

**Available today** (~20 tools): solicitations, reviews, awards, funds, and
opportunity lookup CRUD. Production-ready.

**Needs to be built** (tracked under CCC-301 and related):
- Program + Opportunity create/update/delete
- Verification rule, delivery unit, payment unit configuration
- LLO invite API (blocked on LLO Directory data model)
- Invoice API for closeout

Until the CRUD APIs land, `connect-program-setup`, `connect-opp-setup`,
`llo-invite`, `llo-launch`, and `opp-closeout` fall back to
document-generation + human action in the Connect admin UI.

### CommCare API (`connect-labs` MCP + `scout-data` MCP)

**Available today**: app structure tools (`list_apps`, `get_app_structure`,
`get_form_questions`, `get_form_json_paths`), bundled resources (app metadata,
domain metadata, user lookup), and analytics via `scout-data` MCP.

**Needs to be built**:
- App upload + build + publish (needed by `app-deploy`)
- Form submission / case data access beyond aggregate analytics

### OCS (composite `ace-ocs` MCP)

**Live**: 22 atomic capabilities across a composite backend that routes each
atom to REST (observation) or Playwright (authoring) based on
`mcp/ocs/capability-map.ts`.

**Authoring atoms (10)**: `ocs_clone_chatbot`, `ocs_set_chatbot_system_prompt`,
`ocs_create_collection`, `ocs_upload_collection_files`,
`ocs_wait_for_collection_indexing`, `ocs_attach_knowledge`,
`ocs_set_chatbot_tools`, `ocs_set_source_material`,
`ocs_publish_chatbot_version`, `ocs_get_chatbot_embed_info`.

**Observation atoms (12)**: `ocs_list_chatbots`, `ocs_get_chatbot`,
`ocs_list_sessions`, `ocs_get_session`, `ocs_end_session`,
`ocs_add_session_tags`, `ocs_remove_session_tags`,
`ocs_update_session_state`, `ocs_send_test_message`,
`ocs_trigger_bot_message`, `ocs_update_participant_data`, `ocs_download_file`.

Authentication is session-based — run `/ace:ocs-login` before calling
Playwright-backed atoms.

### Nova

**Does not exist yet as an MCP.** Key open question: can Nova be driven
programmatically by ACE? Options under exploration with Braxton:

1. **Nova API** (preferred) — Nova exposes REST endpoint that accepts IDD and
   returns a `.ccz` / app JSON.
2. **Nova fork** — fork Nova and add headless/API mode. Viable if fork
   maintenance is acceptable.
3. **Headless browser** (not recommended) — drive Nova's UI via gstack.

Until resolved, `idd-to-learn-app` and `idd-to-deliver-app` produce Nova briefs
and hand off to a human.

## Current Limitations

Skills with `## Current Workaround` sections (APIs blocked on external work):

| Skill | Blocker | Workaround |
|-------|---------|------------|
| `idd-to-learn-app` | Nova API does not exist | Generate Nova brief → manual Nova session |
| `idd-to-deliver-app` | Nova API does not exist | Generate Nova brief → manual Nova session |
| `app-deploy` | CommCare upload API pending | Produce upload checklist → manual HQ UI upload |
| `connect-program-setup` | `create_program` pending (CCC-301) | Recommend program → manual Connect UI creation |
| `connect-opp-setup` | Opportunity CRUD pending (CCC-301) | Generate opp-config spec → manual Connect UI creation |
| `llo-invite` | Connect invite API pending | Produce recommended invite list → manual invites |
| `llo-launch` | Connect activation API pending | Ask user to activate via Connect UI |
| `llo-feedback` | Automated monitoring partial | Drafts feedback emails; user sends and records responses |
| `opp-closeout` | Connect invoice API pending | Manually pull invoices → Atlassian MCP for Jira ticket |

## Skill Reference

| Skill | MCP Tools | LLM-as-Judge |
|-------|-----------|--------------|
| `idea-to-idd` | Drive | Yes (5-question stress-test rubric) |
| `idd-to-learn-app` | Drive, Nova (pending) | Yes |
| `idd-to-deliver-app` | Drive, Nova (pending) | Yes |
| `app-deploy` | Drive, CommCare (pending) | — |
| `app-test` | Drive, CommCare | Yes (coverage + bug triage) |
| `training-materials` | Drive | Yes (clarity + coverage) |
| `connect-program-setup` | Drive, Connect (partial) | — |
| `connect-opp-setup` | Drive, Connect (pending) | — |
| `llo-invite` | Drive, Connect (pending) | — |
| `llo-onboarding` | Drive, `email-communicator` | — |
| `llo-uat` | Drive, OCS (`ocs_list_sessions`, `ocs_get_session`) | — |
| `llo-launch` | Drive, Connect (pending) | — |
| `ocs-agent-setup` | Drive, OCS (full authoring + observation suite) | Yes (test-prompt self-eval) |
| `ocs-chatbot-qa` | OCS (`ocs_get_chatbot_embed_info`) + raw HTTP | Yes (4-dim rubric) |
| `timeline-monitor` | Drive, Connect, CommCare, OCS | — |
| `flw-data-review` | Drive, CommCare (scout-data), Connect, OCS | Yes (signal vs noise) |
| `opp-closeout` | Drive, Connect (pending), Atlassian | — |
| `llo-feedback` | Drive, OCS (`ocs_list_sessions`) | — |
| `learnings-summary` | Drive, OCS (`ocs_list_sessions`, `ocs_get_session`) | — |
| `cycle-grade` | Drive | Yes (fairness + actionability) |
| `email-communicator` | None (GOG CLI) | — |

## Agent Reference

| Agent | Role | Dispatches To |
|-------|------|---------------|
| `ace-orchestrator` | Top-level: runs the full lifecycle, manages phases, enforces gates in review mode | `app-builder`, `connect-setup`, `llo-manager`, `closeout` |
| `app-builder` | Phase 1: idea through tested + trained apps | `idea-to-idd`, `idd-to-learn-app`, `idd-to-deliver-app`, `app-deploy`, `app-test`, `training-materials` |
| `connect-setup` | Phase 2: Connect platform setup | `connect-program-setup`, `connect-opp-setup`, `llo-invite` |
| `llo-manager` | Phase 3: LLO lifecycle + recurring monitoring | `llo-onboarding`, `llo-uat`, `llo-launch`, `ocs-agent-setup`, `timeline-monitor`, `flw-data-review` |
| `closeout` | Phase 4: financial closeout + learnings | `opp-closeout`, `llo-feedback`, `learnings-summary`, `cycle-grade` |
| `ocs-tester` | Standalone: OCS chatbot quality evaluation (pre-launch QA, ongoing monitoring, golden-template validation, ad-hoc debugging) | `ocs-chatbot-qa` |
