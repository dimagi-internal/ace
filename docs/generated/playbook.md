# ACE Playbook — CRISPR-Connect Process

Generated: 2026-04-08

## Overview

ACE (AI Connect Engine) is a Claude Code plugin that orchestrates the full CRISPR-Connect lifecycle for Connect opportunities. It manages everything from initial idea through app building, platform setup, LLO (Local Lead Organization) management, and closeout. ACE is built around 5 agents, 19 skills, and integrations with Connect, CommCare, OCS, and Nova.

ACE supports two execution modes:

- **Auto mode:** Runs all phases sequentially without human gates. Emails the CRISPR Admin group (Neal, Jon, Matt, Sarvesh, Cal) at each step completion and on failures. Gates are logged but not enforced.
- **Review mode:** Runs all phases sequentially but pauses at gate steps. Uses interactive prompts to present results and get approval before proceeding. Gate steps are: after IDD creation, after app deployment, after LLO invite list generation, and after opportunity go-live readiness.

Opportunity state lives in Google Drive under `ACE/<opp-name>/`, tracked in a `state.yaml` file that records the current phase, step, mode, archetype, timestamps, gate approvals, and errors.

## Skill Framework

Every ACE skill is a SKILL.md file under `skills/` that follows the contract documented at `skills/README.md`. Skills are stateless prompt definitions that Claude executes — they read from and write to the opportunity's GDrive folder and call MCP tools for external system access.

Two framework primitives shape how skills branch on the IDD:

### Delivery archetypes

Every IDD declares a delivery `Archetype:` in its frontmatter. The archetype determines how downstream skills behave:

- **`atomic-visit`** — one FLW visit produces one structured delivery (photo + GPS + form). Verification is automated. Examples: turmeric market survey, household-level data collection. **Default if unspecified.**
- **`focus-group`** — one FLW-facilitated group session produces qualitative content (audio + per-domain summaries + attendance). Verification mixes automated session-level checks with AI-assisted content evaluation. Example: vaccine-hesitancy Stage 1 focus groups.
- **`multi-stage`** — combines two or more archetypes across sequenced stages, each with its own gate. Example: full vaccine-hesitancy IDD (Stage 1 = focus-group, Stage 2 = atomic household visits).

7 of the 19 skills branch on archetype: `idea-to-idd`, `idd-to-learn-app`, `idd-to-deliver-app`, `app-test`, `connect-opp-setup`, `flw-data-review`, `cycle-grade`. Each has a `## Archetypes` section in its SKILL.md describing the per-archetype behavior. Adding a new archetype is an additive change to those 7 skills plus the IDD template — no new skill files.

### Evidence Model (Layer A / B / C)

Every IDD declares an `## Evidence Model` section using a shared three-layer vocabulary:

- **Layer A — Delivery proof** (the thing happened). Automated, hard gates. Drives verification rules in `connect-opp-setup` and capture-path tests in `app-test`.
- **Layer B — Content proof** (it was done properly). AI-assisted or structured human review. Drives content-quality tests in `app-test` and per-delivery review in `flw-data-review`.
- **Layer C — Cross-delivery quality** (the data is useful). AI synthesis. Drives cross-delivery review in `flw-data-review` and Intervention Effectiveness / Research Quality grading in `cycle-grade`.

4 downstream skills (`connect-opp-setup`, `app-test`, `flw-data-review`, `cycle-grade`) read from the IDD's Evidence Model section as their primary input rather than re-deriving verification from the IDD body. They error out if the section is missing — that signals `idea-to-idd` short-circuited the stress-test rubric.

### Stress-test rubric (in `idea-to-idd`)

`idea-to-idd` self-evaluates every drafted IDD against a 5-question rubric — **executability, verifiability, measurability, stage-gate clarity, resource realism** — and blocks IDD approval at ≥2 non-pass. The rubric includes calibrated grading anchors from the example IDDs at `docs/examples/idd-vaccine-hesitancy.md` (canonical fail) and `docs/examples/idd-turmeric-market-survey.md` (canonical near-pass).

## Process Flow

| Step | Name | Skill | Phase | LLM-as-Judge | Gate | Recurring | Archetype-aware |
|------|------|-------|-------|:---:|:---:|:---:|:---:|
| 1 | Idea to IDD | `idea-to-idd` | App Building | Yes | Yes | No | Yes |
| 2 | IDD to Learn App | `idd-to-learn-app` | App Building | Yes | No | No | Yes |
| 3 | IDD to Deliver App | `idd-to-deliver-app` | App Building | Yes | No | No | Yes |
| 4 | App Deploy | `app-deploy` | App Building | No | Yes | No | No |
| 5 | App Test | `app-test` | App Building | Yes | No | No | Yes |
| 6 | Training Materials | `training-materials` | App Building | Yes | No | No | No |
| 7 | Connect Program Setup | `connect-program-setup` | Connect Setup | No | No | No | No |
| 8 | Connect Opportunity Setup | `connect-opp-setup` | Connect Setup | No | No | No | Yes |
| 9 | LLO Invite | `llo-invite` | Connect Setup | No | Yes | No | No |
| 10 | LLO Onboarding | `llo-onboarding` | LLO Management | No | No | No | No |
| 11 | LLO User Acceptance Testing | `llo-uat` | LLO Management | No | No | No | No |
| 12 | LLO Launch (go-live) | `llo-launch` | LLO Management | No | Yes | No | No |
| 13 | OCS Agent Setup | `ocs-agent-setup` | LLO Management | Yes | No | No | No |
| 14 | Timeline Monitor | `timeline-monitor` | LLO Management | Yes | No | Yes | No |
| 15 | FLW Data Review | `flw-data-review` | LLO Management | Yes | No | Yes | Yes |
| 16 | Opportunity Closeout | `opp-closeout` | Closeout | No | No | No | No |
| 17 | LLO Feedback | `llo-feedback` | Closeout | No | No | No | No |
| 18 | Learnings Summary | `learnings-summary` | Closeout | No | No | No | No |
| 19 | Cycle Grade | `cycle-grade` | Closeout | Yes | No | No | Yes |

Notes: Steps 2–3 run in parallel. Steps 5–6 run in parallel. Steps 14–15 run weekly on a recurring schedule during the active opportunity.

## Phase 1: App Building

### Agent: app-builder

Orchestrates the app building phase of CRISPR-Connect: idea iteration into an IDD, passing the IDD to Nova for Learn and Deliver apps, deploying to CommCare HQ, testing, and creating training materials. The agent manages step sequencing, runs parallel steps where possible (IDD-to-app generation, test-and-train), and enforces gates in review mode.

### Skills

#### idea-to-idd

Iterate on an idea to produce a well-specified Intervention Design Doc (IDD) for a Connect application. Defines the intervention, target FLWs, visit structure, and preferred LLOs. **Archetype-aware**: branches on `atomic-visit` / `focus-group` / `multi-stage` to add the correct sections to the IDD draft (recruitment plan, facilitation protocol, question guide, output specification for focus groups; standard form-walkthrough sections for atomic visits). **Self-evaluates** with the 5-question stress-test rubric (executability, verifiability, measurability, stage-gate clarity, resource realism) and blocks approval at ≥2 non-pass. Includes calibrated grading anchors from `docs/examples/idd-vaccine-hesitancy.md` and `docs/examples/idd-turmeric-market-survey.md`. Stress-test results emitted as a `## Stress Test Results` appendix on every IDD. In review mode this is a gate step requiring human approval before apps are generated. Uses Google Drive MCP tools.

#### idd-to-learn-app

Pass an IDD to Nova to generate the Learn app. Answer Nova's configuration questions and output the app JSON/CCZ and a summary of decisions made. **Archetype-aware**: for `atomic-visit` IDDs, generates a standard form-walkthrough Learn app brief; for `focus-group` IDDs, generates a *facilitation training* brief (facilitation basics, probing techniques, neutral framing, group dynamics, question-guide walkthrough, session-form walkthrough, consent and ethics, logistics) — explicitly *not* a form walkthrough. For `multi-stage` IDDs, generates per-stage apps. Currently falls back to generating a structured app brief for manual Nova interaction until the Nova API integration is built. Uses Google Drive and Nova MCP tools.

#### idd-to-deliver-app

Pass an IDD to Nova to generate the Deliver app. **Archetype-aware**: for `atomic-visit` IDDs, generates a per-beneficiary form with case lifecycle per beneficiary; for `focus-group` IDDs, generates a session-documentation form with pre-session, per-question-domain (one section per IDD domain), and post-session blocks, with case management at the **segment level** (not per participant). The Nova prompt is explicit about the difference. Runs in parallel with `idd-to-learn-app`. Currently falls back to a manual brief workflow until Nova integration is available. Uses Google Drive and Nova MCP tools.

#### app-deploy

Upload the generated Learn and Deliver app packages to the CRISPR-Connect domain on CommCare HQ, then trigger the build and publish process. Reads app files from GDrive and produces a deployment summary with app IDs, build status, and published URLs. This is a gate step in review mode — apps must be verified before proceeding. Currently requires manual upload via the HQ UI because the CommCare app upload/build/publish APIs are not yet exposed via MCP. Uses Google Drive and CommCare MCP tools.

#### app-test

Create and execute an automated test plan for the Learn and Deliver apps; identify bugs and issues before LLO deployment. **Archetype-aware** and **Evidence-Model-consuming**: reads the IDD's `archetype:` and `## Evidence Model` section in step 3, then uses Layer A entries as the checklist of what must be capturable end-to-end (every Layer A artifact gets a passing capture test) and Layer B entries to determine which content fields need length and quality validation tests. For `atomic-visit`, covers form completion, case management, skip logic, validation, edge cases, cross-form data flow. For `focus-group`, covers per-domain section coverage, file-upload paths (audio, attendance photo), consent gating, and segment-level case lifecycle — explicitly *not* per-beneficiary atomicity. Errors out if the IDD has no Evidence Model section. Uses Google Drive and CommCare MCP tools.

#### training-materials

Generate training materials for LLOs and FLWs from app summaries and template collateral. Output guides, quick-reference cards, and onboarding docs. The skill produces an LLO Manager Guide, an FLW Training Guide, a Quick Reference Card, and an FAQ, and self-evaluates whether instructions are clear enough for someone with no prior context. Uses Google Drive MCP tools.

## Phase 2: Connect Setup

### Agent: connect-setup

Orchestrates Connect platform setup for a CRISPR-Connect opportunity: program creation, opportunity configuration, and LLO invitations. Steps are sequential because each depends on the previous one's output (Program ID, then Opportunity ID).

### Skills

#### connect-program-setup

Create or configure a Program in Connect for the CRISPR-Connect opportunity. Checks if an existing program fits before creating a new one. Currently requires manual program creation via the Connect UI because the `create_program` API is not yet built (tracked as CCC-301). Generates the recommended program configuration and asks the user to create it. Uses Google Drive and Connect MCP tools.

#### connect-opp-setup

Create and configure an Opportunity in Connect — including verification rules, delivery units, payment units, and all other configuration needed for the opp. **Archetype-aware** and **Evidence-Model-consuming**: reads the IDD's `archetype:` and `## Evidence Model` section in step 2, then uses **Layer A** entries as the spec for verification rules (each Layer A row → one rule) and treats Layer B/C entries as soft flags (logged for human review, not blocking). For `atomic-visit`, delivery unit = one verified beneficiary visit; for `focus-group`, delivery unit = one **completed group session** (not per participant) and payment unit count is set from the IDD's planned session count. Errors out if the IDD has no Evidence Model section. Currently requires manual opportunity creation via the Connect UI because the `create_opportunity` and related configuration APIs are not yet built (CCC-301). Uses Google Drive and Connect MCP tools.

#### llo-invite

Look up LLO contacts from the LLO Directory and invite them to the Connect opportunity. Reads the IDD's LLO preference section, searches the LLO Directory for matching organizations, and prepares an invite list with rationale for each selection. This is a gate step in review mode — the invite list must be approved before invitations are sent. Currently requires manual invite sending via the Connect UI because the `send_llo_invite` API is not yet built. Uses Google Drive and Connect MCP tools.

## Phase 3: LLO Management

### Agent: llo-manager

Orchestrates LLO management during an active opportunity: onboarding, UAT, go-live, OCS agent setup, timeline monitoring, and FLW data review. This phase includes two recurring skills (`timeline-monitor` and `flw-data-review`) that execute on a weekly schedule throughout the active opportunity period. The phase is "complete" when the opportunity reaches its end date.

### Skills

#### llo-onboarding

Send onboarding emails to invited LLOs with training materials, app instructions, and next steps. Uses Ace-AI@Dimagi.com as sender, with all emails CC'd to the CRISPR Admin group. Currently generates email drafts for the user to send manually until email sending is automated. Uses Google Drive MCP tools.

#### llo-uat

Coordinate User Acceptance Testing with onboarded LLOs. Send UAT instructions, monitor for feedback, and compile results with LLO sign-off status. Reads OCS transcripts during the UAT window for surfaced issues. Uses Google Drive and OCS MCP tools.

#### llo-launch

Activate the opportunity for live use. Verify UAT sign-offs, activate the opportunity in Connect, confirm apps are published, and notify LLOs of go-live. This is a gate step in review mode — launch readiness must be verified before activating. Uses Google Drive, Connect, and CommCare MCP tools.

#### ocs-agent-setup

Configure an OCS agent for this opportunity. Inject the IDD, training materials, and opportunity context so OCS can answer LLO questions. Composes a context document, creates the agent, sets email routing to Ace-AI@Dimagi.com, and configures admin-group CC rules. Self-evaluates whether the context is comprehensive enough for typical LLO questions. Currently requires manual OCS agent creation because the OCS MCP server is not yet built. Uses Google Drive and OCS MCP tools.

#### timeline-monitor

Monitor whether LLOs are hitting expected milestones on schedule; send prompting emails if behind. Runs recurring during the active opportunity (typically weekly). Reads timeline data from the IDD, checks FLW activity via CommCare submission data and Connect opportunity status, and drafts prompting emails to LLOs who are behind schedule. Reports are written to GDrive and the admin group is notified. Uses Google Drive, Connect, and CommCare/scout-data MCP tools.

#### flw-data-review

Analyze FLW submission data to identify quality issues, trends, and improvement opportunities. Generate recommendations for the team. Runs recurring during active opp. **Archetype-aware** and **Evidence-Model-consuming**: reads the IDD's `archetype:` and `## Evidence Model` section in step 1; Layer B drives per-delivery evaluation, Layer C drives cross-delivery synthesis. For `atomic-visit`, performs quantitative review (submission rates, completion rates, outlier detection, cap compliance, per-FLW outliers, cross-FLW clustering). For `focus-group`, performs qualitative synthesis (per-session quality, cross-session theme synthesis by segment, saturation check, quote bank, facilitator coaching signals) — explicitly *not* quantitative checks. Uses Google Drive, CommCare/scout-data, and Connect MCP tools.

## Phase 4: Closeout

### Agent: closeout

Orchestrates opportunity closeout: invoice processing, LLO feedback collection, learnings summary, and overall cycle grading. Triggered when the opportunity reaches its end date. The learnings summary can trigger another CRISPR-Connect cycle by drafting a new IDD.

### Skills

#### opp-closeout

Pull invoices from the completed opportunity and create a Jira ticket to issue payment to the LLO. Currently requires manual invoice pulling from the Connect UI because the invoice API is not yet built. Uses Google Drive, Connect, and Jira (Atlassian) MCP tools.

#### llo-feedback

Prompt LLOs for feedback about the application, process, and suggestions for next steps. Collect and document responses. Composes feedback request emails covering app usability, process experience, FLW challenges, improvement suggestions, and interest in future opportunities. Sends from Ace-AI@Dimagi.com with admin group CC, monitors for responses via OCS transcripts. Currently generates email drafts for manual sending. Uses Google Drive and OCS MCP tools.

#### learnings-summary

Summarize learnings from the completed opportunity and create a new IDD if iteration is warranted. Can trigger another CRISPR-Connect cycle. Reads the original IDD, test results, monitoring reports, data reviews, OCS transcripts, LLO feedback, and comms logs, then analyzes what worked, what did not, and whether success metrics were met. Produces process, content, technical, and relationship learnings. Uses Google Drive and OCS MCP tools.

#### cycle-grade

Grade the overall CRISPR-Connect cycle with recommendations for improvements and next steps. **Archetype-aware** and **Evidence-Model-consuming**: reads the IDD's `archetype:` and `## Evidence Model` section in step 1 and uses Layer A as the source of FLW Performance evidence and Layer B/C as the source of Intervention Effectiveness / Research Quality evidence. For `atomic-visit`, grades 6 dimensions (intervention effectiveness, app quality, LLO execution, FLW performance, process efficiency, communication quality) with **FLW Performance** scored on submission volume / data quality / cap compliance. For `focus-group`, scores **FLW Performance** on facilitation quality (probing depth, balance, summary specificity, audio completeness) — *not* volume — and **Intervention Effectiveness** on research yield (theme specificity, segment differentiation, IDD research questions answered), and adds a 7th dimension: **Research Quality**. For `multi-stage`, grades each stage's archetype separately and produces an overall grade that also assesses stage-gate transitions. Self-evaluates grading fairness. Uses Google Drive MCP tools.

## External Integrations

### Connect API

The connect-labs MCP provides approximately 20 production-ready tools for solicitations, reviews, awards, funds, and opportunity lookup. Key gaps that must be built (tracked as CCC-301): Program and Opportunity CRUD APIs (`create_program`, `create_opportunity`, etc.), opportunity configuration APIs (verification rules, delivery units, payment units), LLO invite API (`send_llo_invite`), and invoice API (`list_invoices`). The `connect-program-setup`, `connect-opp-setup`, `llo-invite`, and `opp-closeout` skills are blocked on these APIs and currently fall back to manual workflows. The "Experiment" generic delivery type is also a Connect-side prerequisite for focus-group opportunities.

### CommCare API

The connect-labs MCP provides app structure tools (`list_apps`, `get_app_structure`, `get_form_questions`, `get_form_json_paths`) and resource bundles (app metadata, domain metadata, user lookup). The scout-data MCP provides analytics query access for FLW data analysis. Key gaps: app upload/build/publish APIs (needed by `app-deploy`) and individual form submission/case data lookup (needed by `app-test`). Until these are built, app deployment requires manual upload via the HQ UI.

### OCS

OCS is ACE's communication layer with LLOs. ACE creates an OCS agent per opportunity that handles LLO questions via Ace-AI@Dimagi.com, with all responses CC'd to the admin group. ACE reads OCS transcripts for sentiment analysis, recurring question identification, and issue escalation. The OCS MCP server needs to be built; key questions to scope with Jon include whether OCS agents can be created programmatically, how context injection works, and what the transcript API looks like. Planned tools: `ocs_create_agent`, `ocs_update_context`, `ocs_list_transcripts`, `ocs_get_transcript`, `ocs_agent_status`.

### Nova

Nova generates CommCare applications from IDDs. The key open question is whether Nova can be driven programmatically (to be explored with Braxton). Three integration options exist in priority order: Nova REST API (preferred, fully automated), Nova fork with headless mode (viable but maintenance burden), or headless browser automation (not recommended, brittle). Until resolved, the `idd-to-learn-app` and `idd-to-deliver-app` skills generate structured app briefs for manual Nova interaction.

## Test Fixtures

ACE has two permanent synthetic test fixtures under `test/fixtures/`. Use these to regression-test skill changes before running on real opportunities. Always run with `--dry-run`.

| Fixture | Archetype | Purpose |
|---|---|---|
| **CRISPR-Test-001** | `atomic-visit` | CHW training pilot for maternal/child health. Standard Learn + Deliver apps with per-beneficiary case management. Protects atomic-visit code paths. |
| **CRISPR-Test-002** | `focus-group` | Simplified vaccine-hesitancy IDD (Stage 1 only, 2 segments, 1 LLO). Stress-test rubric all-pass, full Evidence Model declared. Protects focus-group code paths in the 7 archetype-aware skills. |

Each fixture has a README documenting the expected per-skill behavior — the regression spec a human or future automated runner can compare against.

## Current Limitations

The following skills have manual workarounds due to APIs or integrations that are not yet built:

| Skill | Workaround |
|-------|------------|
| `idd-to-learn-app` | Generates a structured app brief from the IDD Learn spec; user must create the app in Nova manually and upload the resulting package to GDrive. |
| `idd-to-deliver-app` | Generates a structured app brief from the IDD Deliver spec; user must create the app in Nova manually and upload the resulting package to GDrive. |
| `app-deploy` | Provides the app package and upload instructions; user must upload via CommCare HQ UI, trigger Build and Publish, and confirm apps are live. |
| `connect-program-setup` | Determines program requirements and generates configuration; user must create the program in the Connect UI and provide the Program ID. |
| `connect-opp-setup` | Generates a complete configuration spec document; user must create the opportunity in the Connect UI following the spec and provide the Opportunity ID. |
| `llo-invite` | Generates a recommended invite list with rationale; user must review and send invites through the Connect UI. |
| `llo-onboarding` | Generates email content for each LLO; user must send the emails from Ace-AI@Dimagi.com. |
| `ocs-agent-setup` | Generates a complete agent context document; user must configure the OCS agent manually with this context. |
| `opp-closeout` | Documents expected payment and invoice details; user must pull invoices from Connect UI and create the Jira payment ticket. |
| `llo-feedback` | Generates feedback request email drafts; user must send and collect responses manually. |

## Skill Reference

| Skill | Description | MCP Tools | Archetype-aware | Reads Evidence Model | LLM-as-Judge | Has Workaround |
|-------|-------------|-----------|:---:|:---:|:---:|:---:|
| `idea-to-idd` | Iterate on an idea to produce an Intervention Design Doc | Google Drive | Yes | Writes it | Yes (5-question stress-test rubric) | No |
| `idd-to-learn-app` | Generate the Learn app from the IDD via Nova | Google Drive, Nova | Yes | No | Yes | Yes |
| `idd-to-deliver-app` | Generate the Deliver app from the IDD via Nova | Google Drive, Nova | Yes | No | Yes | Yes |
| `app-deploy` | Upload and publish apps to CommCare HQ | Google Drive, CommCare | No | No | No | Yes |
| `app-test` | Test deployed apps against a generated test plan | Google Drive, CommCare | Yes | Yes | Yes | No |
| `training-materials` | Generate LLO/FLW training docs from app summaries | Google Drive | No | No | Yes | No |
| `connect-program-setup` | Create or select a Connect program | Google Drive, Connect | No | No | No | Yes |
| `connect-opp-setup` | Create and configure a Connect opportunity | Google Drive, Connect | Yes | Yes | No | Yes |
| `llo-invite` | Identify and invite LLOs to the opportunity | Google Drive, Connect | No | No | No | Yes |
| `llo-onboarding` | Send onboarding emails to LLOs | Google Drive | No | No | No | Yes |
| `llo-uat` | Coordinate UAT with onboarded LLOs | Google Drive, OCS | No | No | No | No |
| `llo-launch` | Verify UAT sign-offs and activate opportunity | Google Drive, Connect, CommCare | No | No | No | No |
| `ocs-agent-setup` | Configure an OCS agent for LLO support | Google Drive, OCS | No | No | Yes | Yes |
| `timeline-monitor` | Check LLO progress against milestones (recurring) | Google Drive, Connect, CommCare/scout-data | No | No | Yes | No |
| `flw-data-review` | Analyze FLW submission data for quality (recurring) | Google Drive, CommCare/scout-data, Connect | Yes | Yes | Yes | No |
| `opp-closeout` | Pull invoices and create Jira payment ticket | Google Drive, Connect, Jira | No | No | No | Yes |
| `llo-feedback` | Collect LLO feedback on the completed opportunity | Google Drive, OCS | No | No | No | Yes |
| `learnings-summary` | Synthesize learnings; optionally draft new IDD | Google Drive, OCS | No | No | No | No |
| `cycle-grade` | Grade the full cycle across 6 (atomic-visit) or 7 (focus-group) dimensions | Google Drive | Yes | Yes | Yes | No |
