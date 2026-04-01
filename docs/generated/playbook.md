# ACE Playbook — CRISPR-Connect Process

Generated: 2026-04-01

## Overview

ACE (AI Connect Engine) is a Claude Code plugin that orchestrates the full CRISPR-Connect lifecycle for Connect opportunities. It manages everything from initial idea through app building, platform setup, LLO (Local Lead Organization) management, and closeout. ACE is built around 5 agents, 17 skills, and integrations with Connect, CommCare, OCS, and Nova.

ACE supports two execution modes:

- **Auto mode:** Runs all phases sequentially without human gates. Emails the CRISPR Admin group (Neal, Jon, Matt, Sarvesh, Cal) at each step completion and on failures. Gates are logged but not enforced.
- **Review mode:** Runs all phases sequentially but pauses at gate steps. Uses interactive prompts to present results and get approval before proceeding. Gate steps are: after IDD creation, after app deployment, and after LLO invite list generation.

Opportunity state lives in Google Drive under `ACE/<opp-name>/`, tracked in a `state.yaml` file that records the current phase, step, mode, timestamps, gate approvals, and errors.

## Process Flow

| Step | Name | Skill | Phase | LLM-as-Judge | Gate | Recurring |
|------|------|-------|-------|:---:|:---:|:---:|
| 1 | Idea to IDD | `idea-to-idd` | App Building | Yes | Yes | No |
| 2 | IDD to Learn App | `idd-to-learn-app` | App Building | Yes | No | No |
| 3 | IDD to Deliver App | `idd-to-deliver-app` | App Building | Yes | No | No |
| 4 | App Deploy | `app-deploy` | App Building | No | Yes | No |
| 5 | App Test | `app-test` | App Building | Yes | No | No |
| 6 | Training Materials | `training-materials` | App Building | Yes | No | No |
| 7 | Connect Program Setup | `connect-program-setup` | Connect Setup | No | No | No |
| 8 | Connect Opportunity Setup | `connect-opp-setup` | Connect Setup | No | No | No |
| 9 | LLO Invite | `llo-invite` | Connect Setup | No | Yes | No |
| 10 | LLO Onboarding | `llo-onboarding` | LLO Management | No | No | No |
| 11 | OCS Agent Setup | `ocs-agent-setup` | LLO Management | Yes | No | No |
| 12 | Timeline Monitor | `timeline-monitor` | LLO Management | Yes | No | Yes |
| 13 | FLW Data Review | `flw-data-review` | LLO Management | Yes | No | Yes |
| 14 | Opportunity Closeout | `opp-closeout` | Closeout | No | No | No |
| 15 | LLO Feedback | `llo-feedback` | Closeout | No | No | No |
| 16 | Learnings Summary | `learnings-summary` | Closeout | No | No | No |
| 17 | Cycle Grade | `cycle-grade` | Closeout | Yes | No | No |

Notes: Steps 2-3 run in parallel. Steps 5-6 run in parallel. Steps 12-13 run weekly on a recurring schedule during the active opportunity.

## Phase 1: App Building

### Agent: app-builder

Orchestrates the app building phase of CRISPR-Connect: idea iteration into an IDD, passing the IDD to Nova for Learn and Deliver apps, deploying to CommCare HQ, testing, and creating training materials. The agent manages step sequencing, runs parallel steps where possible (IDD-to-app generation, test-and-train), and enforces gates in review mode.

### Skills

#### idea-to-idd

Takes an initial idea and iterates on it to produce a complete Intervention Design Document (IDD). The IDD specifies the intervention, target FLWs, visit structure, app requirements for both Learn and Deliver apps, success metrics, and preferred LLOs. The skill reads the idea from GDrive, researches and expands it into a structured IDD with sections covering problem statement through timeline, then self-evaluates for completeness and feasibility using LLM-as-Judge. In review mode this is a gate step requiring human approval before apps are generated. Uses Google Drive MCP tools.

#### idd-to-learn-app

Generates the Learn (data collection) app from the approved IDD by passing the Learn app spec to Nova. The skill extracts data collection requirements, visit structure, form design, and case management needs from the IDD, then provides these to Nova and captures all configuration decisions. It self-evaluates whether the generated app matches the IDD spec. Currently falls back to generating a structured app brief for manual Nova interaction until the Nova API integration is built. Uses Google Drive and Nova MCP tools.

#### idd-to-deliver-app

Generates the Deliver (service delivery) app from the approved IDD by passing the Deliver app spec to Nova. The skill extracts service delivery workflows, verification criteria, payment triggers, and case management needs from the IDD. It follows the same pattern as `idd-to-learn-app` -- self-evaluates the generated app against the IDD spec and falls back to a manual brief workflow until Nova integration is available. Runs in parallel with `idd-to-learn-app`. Uses Google Drive and Nova MCP tools.

#### app-deploy

Uploads the generated Learn and Deliver app packages to the CRISPR-Connect domain on CommCare HQ, then triggers the build and publish process. The skill reads app files from GDrive and produces a deployment summary with app IDs, build status, and published URLs. This is a gate step in review mode -- apps must be verified before proceeding. Currently requires manual upload via the HQ UI because the CommCare app upload/build/publish APIs are not yet exposed via MCP. Uses Google Drive and CommCare MCP tools.

#### app-test

Creates a comprehensive test plan and executes it against the deployed Learn and Deliver apps. The skill generates test cases covering form completion flows, case management, skip logic, validation rules, edge cases, and cross-form data flow. It uses the CommCare MCP to inspect app structure and form questions, documents each test case with pass/fail results, and self-evaluates test coverage. Outputs a test plan, results, and bug list with severity and repro steps. Uses Google Drive and CommCare MCP tools.

#### training-materials

Generates training materials for LLOs and FLWs from the IDD and app summaries. Produces four documents: an LLO Manager Guide (opportunity overview, timeline, expectations), an FLW Training Guide (step-by-step app instructions), a Quick Reference Card (one-page workflow summary), and an FAQ (anticipated questions). The skill self-evaluates whether instructions are clear enough for someone with no prior context and whether all key workflows are covered. Uses Google Drive MCP tools.

## Phase 2: Connect Setup

### Agent: connect-setup

Sets up the Connect platform for a CRISPR-Connect opportunity: program creation or reuse, opportunity configuration with verification rules and delivery/payment units, and LLO invitations. Steps are sequential because each depends on the previous one's output (Program ID, then Opportunity ID).

### Skills

#### connect-program-setup

Creates or selects a Connect program for the opportunity. The skill reads the IDD, checks for existing programs that match the opportunity's domain, and decides whether to reuse an existing program or create a new one. Currently requires manual program creation via the Connect UI because the `create_program` API is not yet built (tracked as CCC-301). The skill generates the recommended program configuration and asks the user to create it. Uses Google Drive and Connect MCP tools.

#### connect-opp-setup

Creates and fully configures a Connect opportunity including verification rules (mapped from IDD success metrics and Deliver app structure), delivery units (based on intervention design), and payment units (based on delivery units and budget). The skill reads the IDD, program details, and deployment summary to generate a complete configuration spec. Currently requires manual opportunity creation via the Connect UI because the `create_opportunity` and related configuration APIs are not yet built (CCC-301). Uses Google Drive and Connect MCP tools.

#### llo-invite

Identifies and invites LLOs to participate in the opportunity. The skill reads the IDD's LLO preference section, searches the LLO Directory for matching organizations, and prepares an invite list with rationale for each selection. This is a gate step in review mode -- the invite list must be approved before invitations are sent. Currently requires manual invite sending via the Connect UI because the `send_llo_invite` API is not yet built. Uses Google Drive and Connect MCP tools.

## Phase 3: LLO Management

### Agent: llo-manager

Manages LLO relationships during an active opportunity: onboarding new LLOs, configuring the OCS support agent, and running ongoing monitoring. This phase includes two recurring skills (timeline-monitor and flw-data-review) that execute on a weekly schedule throughout the active opportunity period. The phase is "complete" when the opportunity reaches its end date.

### Skills

#### llo-onboarding

Sends onboarding communications to LLOs who accepted the opportunity invitation. For each LLO, the skill composes a welcome email from Ace-AI@Dimagi.com with opportunity overview, links to training materials, step-by-step getting-started instructions, timeline, and support contact information. All emails CC the CRISPR Admin group. Currently generates email drafts for the user to send manually until email sending is automated. Uses Google Drive MCP tools.

#### ocs-agent-setup

Creates and configures an OCS (Operational Conversational System) agent to handle LLO questions for the opportunity. The skill composes a context document from the IDD, training materials, app summaries, and opportunity details, then creates an OCS agent with that context, email routing to Ace-AI@Dimagi.com, and admin-group CC rules. Self-evaluates whether the context is comprehensive enough for typical LLO questions. Currently requires manual OCS agent creation because the OCS MCP server is not yet built. Uses Google Drive and OCS MCP tools.

#### timeline-monitor

Runs periodically (weekly) during the active opportunity to check whether LLOs are hitting expected milestones on schedule. The skill reads timeline data from the IDD, checks FLW activity via CommCare submission data and Connect opportunity status, and drafts prompting emails to LLOs who are behind schedule. Self-evaluates assessment accuracy and recommendation quality. Reports are written to GDrive and the admin group is notified. Uses Google Drive, Connect, and CommCare/scout-data MCP tools.

#### flw-data-review

Runs periodically (weekly) during the active opportunity to analyze FLW submission data for quality issues. The skill queries scout-data for submission rates, completion rates, dropout patterns, data quality issues, and case management compliance, then compares against the IDD's expected metrics. Self-evaluates whether identified patterns are real signals and whether recommendations are actionable. Generates specific improvement recommendations for the team to relay to LLOs. Uses Google Drive, CommCare/scout-data, and Connect MCP tools.

## Phase 4: Closeout

### Agent: closeout

Handles the closeout of a completed CRISPR-Connect opportunity. Triggered when the opportunity reaches its end date. Processes invoices and payment, collects LLO feedback, synthesizes learnings across the entire cycle, and produces a final cycle grade. The learnings summary can trigger another CRISPR-Connect cycle by drafting a new IDD.

### Skills

#### opp-closeout

Processes the financial closeout of a completed opportunity. The skill pulls invoices from Connect based on verified deliveries, calculates the total payment amount, and creates a Jira ticket for payment processing with invoice details and LLO banking references. Currently requires manual invoice pulling from the Connect UI because the invoice API is not yet built. Uses Google Drive, Connect, and Jira (Atlassian) MCP tools.

#### llo-feedback

Collects feedback from LLOs about the completed opportunity. The skill composes feedback request emails covering app usability, process experience, FLW challenges, improvement suggestions, and interest in future opportunities. Sends from Ace-AI@Dimagi.com with admin group CC, monitors for responses via OCS transcripts, and documents all feedback with common themes. Currently generates email drafts for manual sending. Uses Google Drive and OCS MCP tools.

#### learnings-summary

Synthesizes all information from the completed opportunity into actionable learnings. The skill reads the original IDD, test results, monitoring reports, data reviews, OCS transcripts, LLO feedback, and comms logs, then analyzes what worked, what did not, and whether success metrics were met. Produces four categories of learnings: process, content, technical, and relationship. If iteration is warranted, drafts a new IDD that can trigger another CRISPR-Connect cycle. Uses Google Drive and OCS MCP tools.

#### cycle-grade

Produces a final grade and assessment of the complete CRISPR-Connect cycle. Grades across six dimensions on a 0-10 scale: intervention effectiveness, app quality, LLO execution, FLW performance, process efficiency, and communication quality. Self-evaluates whether grading is fair and evidence-based. Generates top-3 successes, top-3 improvements, and per-skill recommendations. Emails the full cycle grade report to the admin group. Uses Google Drive MCP tools.

## External Integrations

### Connect API

The connect-labs MCP provides approximately 20 production-ready tools for solicitations, reviews, awards, funds, and opportunity lookup. Key gaps that must be built (tracked as CCC-301): Program and Opportunity CRUD APIs (`create_program`, `create_opportunity`, etc.), opportunity configuration APIs (verification rules, delivery units, payment units), LLO invite API (`send_llo_invite`), and invoice API (`list_invoices`). The `connect-program-setup`, `connect-opp-setup`, `llo-invite`, and `opp-closeout` skills are blocked on these APIs and currently fall back to manual workflows.

### CommCare API

The connect-labs MCP provides app structure tools (`list_apps`, `get_app_structure`, `get_form_questions`, `get_form_json_paths`) and resource bundles (app metadata, domain metadata, user lookup). The scout-data MCP provides analytics query access for FLW data analysis. Key gaps: app upload/build/publish APIs (needed by `app-deploy`) and individual form submission/case data lookup (needed by `app-test`). Until these are built, app deployment requires manual upload via the HQ UI.

### OCS

OCS is ACE's communication layer with LLOs. ACE creates an OCS agent per opportunity that handles LLO questions via Ace-AI@Dimagi.com, with all responses CC'd to the admin group. ACE reads OCS transcripts for sentiment analysis, recurring question identification, and issue escalation. The OCS MCP server needs to be built; key questions to scope with Jon include whether OCS agents can be created programmatically, how context injection works, and what the transcript API looks like. Planned tools: `ocs_create_agent`, `ocs_update_context`, `ocs_list_transcripts`, `ocs_get_transcript`, `ocs_agent_status`.

### Nova

Nova generates CommCare applications from IDDs. The key open question is whether Nova can be driven programmatically (to be explored with Braxton). Three integration options exist in priority order: Nova REST API (preferred, fully automated), Nova fork with headless mode (viable but maintenance burden), or headless browser automation (not recommended, brittle). Until resolved, the `idd-to-learn-app` and `idd-to-deliver-app` skills generate structured app briefs for manual Nova interaction.

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

| Skill | Description | MCP Tools | LLM-as-Judge | Has Workaround |
|-------|-------------|-----------|:---:|:---:|
| `idea-to-idd` | Iterate on an idea to produce an Intervention Design Doc | Google Drive | Yes | No |
| `idd-to-learn-app` | Generate the Learn app from the IDD via Nova | Google Drive, Nova | Yes | Yes |
| `idd-to-deliver-app` | Generate the Deliver app from the IDD via Nova | Google Drive, Nova | Yes | Yes |
| `app-deploy` | Upload and publish apps to CommCare HQ | Google Drive, CommCare | No | Yes |
| `app-test` | Test deployed apps against a generated test plan | Google Drive, CommCare | Yes | No |
| `training-materials` | Generate LLO/FLW training docs from app summaries | Google Drive | Yes | No |
| `connect-program-setup` | Create or select a Connect program | Google Drive, Connect | No | Yes |
| `connect-opp-setup` | Create and configure a Connect opportunity | Google Drive, Connect | No | Yes |
| `llo-invite` | Identify and invite LLOs to the opportunity | Google Drive, Connect | No | Yes |
| `llo-onboarding` | Send onboarding emails to LLOs | Google Drive | No | Yes |
| `ocs-agent-setup` | Configure an OCS agent for LLO support | Google Drive, OCS | Yes | Yes |
| `timeline-monitor` | Check LLO progress against milestones (recurring) | Google Drive, Connect, CommCare/scout-data | Yes | No |
| `flw-data-review` | Analyze FLW submission data for quality (recurring) | Google Drive, CommCare/scout-data, Connect | Yes | No |
| `opp-closeout` | Pull invoices and create Jira payment ticket | Google Drive, Connect, Jira | No | Yes |
| `llo-feedback` | Collect LLO feedback on the completed opportunity | Google Drive, OCS | No | Yes |
| `learnings-summary` | Synthesize learnings; optionally draft new IDD | Google Drive, OCS | No | No |
| `cycle-grade` | Grade the full cycle across 6 dimensions | Google Drive | Yes | No |
