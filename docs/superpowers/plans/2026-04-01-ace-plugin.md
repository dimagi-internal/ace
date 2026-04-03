# ACE Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ACE Claude Code plugin — agents, skills, commands, integration specs, and OCS MCP scaffold — so it can be installed and used to orchestrate Connect opportunities.

**Architecture:** ACE is a Claude Code plugin following canopy's pattern. 5 agents orchestrate 17 skills. MCP servers provide external system access (Google Drive already built, OCS to scaffold). Opportunity state lives in Google Drive. Skills that depend on unbuilt APIs include manual fallback instructions.

**Tech Stack:** Claude Code plugin (markdown definitions), TypeScript (MCP servers), Google Drive API, OCS API

**Reference:** Design spec at `docs/superpowers/specs/2026-04-01-ace-design.md`

---

### Task 1: Plugin Scaffold and Metadata

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: all empty directories for the plugin structure

- [ ] **Step 1: Create plugin.json**

```json
{
  "name": "ace",
  "version": "0.1.0",
  "description": "AI Connect Engine — orchestrates the CRISPR-Connect lifecycle from idea through app building, Connect setup, LLO management, and closeout",
  "author": {
    "name": "Jonathan Jackson",
    "email": "jjackson@dimagi.com"
  },
  "repository": "https://github.com/jjackson/ace",
  "license": "MIT",
  "keywords": ["connect", "commcare", "orchestration", "crispr"]
}
```

- [ ] **Step 2: Create directory structure**

```bash
mkdir -p .claude-plugin agents commands
mkdir -p skills/{idea-to-idd,idd-to-learn-app,idd-to-deliver-app,app-deploy,app-test,training-materials}
mkdir -p skills/{connect-program-setup,connect-opp-setup,llo-invite}
mkdir -p skills/{llo-onboarding,ocs-agent-setup,timeline-monitor,flw-data-review}
mkdir -p skills/{opp-closeout,llo-feedback,learnings-summary,cycle-grade}
mkdir -p playbook/integrations templates scripts docs/generated
```

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/ agents/ commands/ skills/ playbook/ templates/ scripts/ docs/generated/
git commit -m "feat: add ACE plugin scaffold and directory structure"
```

---

### Task 2: Integration Specs

These documents map what APIs exist today vs. what needs to be built. Skills reference these to know what's available.

**Files:**
- Create: `playbook/integrations/connect-api.md`
- Create: `playbook/integrations/commcare-api.md`
- Create: `playbook/integrations/ocs-integration.md`
- Create: `playbook/integrations/nova-integration.md`

- [ ] **Step 1: Write Connect API integration spec**

File: `playbook/integrations/connect-api.md`

```markdown
# Connect API Integration

## Available Today (via connect-labs MCP)

The connect-labs `commcare-hq` MCP server provides these tools:

### Solicitations
- `list_solicitations(program_id, organization_id, status, solicitation_type)` — list/filter solicitations
- `get_solicitation(solicitation_id)` — get single solicitation with full metadata
- `create_solicitation(title, description, program_id, ...)` — create new solicitation
- `update_solicitation(solicitation_id, data_json)` — update existing solicitation

### Reviews
- `list_reviews(response_id)` — list reviews for a response
- `get_review(review_id)` — get single review
- `create_review(response_id, score, recommendation, ...)` — create review
- `update_review(review_id, data_json)` — update review

### Awards
- `award_response(response_id, reward_budget, org_id, fund_id)` — award a response

### Funds
- `list_funds(program_id)` — list accessible funds
- `get_fund(fund_id)` — get fund with allocation history
- `create_fund(program_id, name, total_budget, ...)` — create fund
- `update_fund(fund_id, data_json)` — update fund
- `add_fund_allocation(fund_id, allocation_json)` — add allocation
- `remove_fund_allocation(fund_id, index)` — remove allocation

### Opportunity Lookup
- `get_opportunity_apps(opportunity_id)` — resolve opp to domain + app IDs
- `get_opportunity_url(opportunity_id)` — get production Connect URL

## Needs to Be Built

### Priority 1: Program + Opportunity CRUD (CCC-301)
- `create_program(name, description, ...)` — create a Connect program
- `create_opportunity(program_id, name, description, delivery_type, ...)` — create opportunity
- `update_opportunity(opportunity_id, data_json)` — update opportunity config
- **Blocks:** connect-program-setup, connect-opp-setup skills

### Priority 2: Opportunity Configuration
- `set_verification_rules(opportunity_id, rules_json)` — configure verification
- `set_delivery_units(opportunity_id, units_json)` — configure delivery units
- `set_payment_units(opportunity_id, units_json)` — configure payment
- **Blocks:** connect-opp-setup skill

### Priority 3: Invite API
- `list_llo_contacts(llo_id)` — look up contacts from LLO Directory
- `send_invite(opportunity_id, contact_id)` — invite LLO to opportunity
- **Blocks:** llo-invite skill
- **Also needs:** LLO Directory in proper data model (Priority 3 in tech work)

### Priority 4: Invoice API
- `get_invoices(opportunity_id)` — pull auto-generated invoices
- **Blocks:** opp-closeout skill

### Unprioritized
- New generic delivery type ("Experiment") — needed for connect-opp-setup
- v2 LLO Entity implementation (CCC-300) — needed for llo-invite, llo-onboarding

## Manual Workaround

Until these APIs exist, skills that need them will:
1. Document exactly what needs to happen
2. Prompt the user to perform the action manually in the Connect UI
3. Ask for confirmation before proceeding to the next step
```

- [ ] **Step 2: Write CommCare API integration spec**

File: `playbook/integrations/commcare-api.md`

```markdown
# CommCare API Integration

## Available Today (via connect-labs MCP)

### App Structure
- `list_apps(domain)` — list all apps in a domain
- `get_app_structure(opportunity_id|domain, app_type)` — module/form/case tree
- `get_form_questions(xmlns, opportunity_id|domain, app_type)` — full question tree
- `get_form_json_paths(xmlns, opportunity_id|domain, app_type)` — JSON submission paths

### Resources (bundled docs)
- `commcare://app-schema` — question type taxonomy, case property mapping
- `commcare://xml-reference` — XForm/Suite/Case XML reference
- `commcare://data-patterns` — form submission JSON patterns

## Needs to Be Built

### App Upload + Build
Currently the app-deploy skill needs to upload app JSON/CCZ to CCHQ and trigger a build.
Options:
1. Use CommCare CLI (old, may need updating)
2. Build MCP tools wrapping the CCHQ app upload API
3. Manual upload as workaround

### Form Data Access
For flw-data-review skill — need to query actual form submission data, not just app structure.
The connect-labs `scout-data` MCP provides SQL queries against materialized CommCare data.
Tools: `query`, `list_tables`, `describe_table`, `list_materializations`, etc.

## Manual Workaround

For app upload: user uploads JSON/CCZ manually via CommCare HQ UI.
For data access: use scout-data MCP for analytics queries.
```

- [ ] **Step 3: Write OCS integration spec**

File: `playbook/integrations/ocs-integration.md`

```markdown
# OCS Integration

## Role in ACE

OCS is ACE's "mouth and ears" for LLO interaction. ACE manages OCS:
- Creates/configures an OCS agent per opportunity
- Injects context: IDD, training materials, opportunity details
- Monitors conversation transcripts for issues
- All LLO communication flows through Ace-AI@Dimagi.com → OCS

## Available APIs

OCS already has APIs for:
- Transcript access (read LLO conversations)
- Agent configuration (TBD — need to explore exact endpoints)

## Needs Exploration

1. **Agent creation API** — can we programmatically create an OCS agent?
2. **Context injection** — how to push IDD + training materials + opp context into an OCS agent?
3. **Dynamic updates** — can ACE update the OCS agent's context mid-opportunity?
4. **Webhook/notification** — can OCS notify ACE when certain events happen (e.g., LLO asks a question ACE should know about)?
5. **Transcript API shape** — what format are transcripts in? How to filter by opp/LLO?

## MCP Server Plan

Build `mcp/ocs-server.ts` in the ACE repo with tools:
- `ocs_create_agent(name, context, config)` — create agent for an opportunity
- `ocs_update_context(agent_id, context)` — update agent's knowledge base
- `ocs_list_transcripts(agent_id, since, llo_filter)` — read conversations
- `ocs_get_transcript(transcript_id)` — get single conversation
- `ocs_agent_status(agent_id)` — check agent health/stats

## Manual Workaround

Until OCS MCP is built, the ocs-agent-setup skill will:
1. Generate the context document (IDD summary + training materials + opp details)
2. Write it to the opportunity's GDrive folder
3. Instruct the user to manually configure the OCS agent with this context
```

- [ ] **Step 4: Write Nova integration spec**

File: `playbook/integrations/nova-integration.md`

```markdown
# Nova Integration

## Role in ACE

Nova generates CommCare applications from an IDD (Intervention Design Doc). ACE passes the IDD to Nova and answers Nova's configuration questions to produce Learn and Deliver apps.

## Current State

Nova is an existing tool. Need to explore with Braxton:
1. Can Nova be controlled via bot/API (not just interactive UI)?
2. What format does Nova expect for input?
3. What questions does Nova ask during configuration?
4. What format does Nova output (JSON, CCZ, both)?
5. Does Nova need to be forked, or can we build an API layer on top?

## Integration Options

### Option A: Nova API (preferred)
- Nova exposes an API for app generation
- ACE sends IDD + config answers → Nova returns app JSON/CCZ
- Cleanest integration, no fork needed

### Option B: Nova Fork
- Fork Nova to add bot-controllable mode
- ACE drives Nova via CLI or API on the fork
- More control but maintenance burden

### Option C: Nova via Headless Browser
- Use gstack/browse to drive Nova's UI programmatically
- Fragile, not recommended for production

## Manual Workaround

Until Nova integration is built:
1. ACE generates a structured brief from the IDD for the app builder
2. ACE writes the brief to the opportunity's GDrive folder
3. User manually creates the app in Nova using the brief
4. User uploads the resulting JSON/CCZ to the GDrive folder
5. ACE picks up from app-deploy step
```

- [ ] **Step 5: Commit**

```bash
git add playbook/
git commit -m "feat: add integration specs for Connect, CommCare, OCS, and Nova"
```

---

### Task 3: Ace-Orchestrator Agent

The top-level agent that dispatches to phase agents and tracks overall opportunity state.

**Files:**
- Create: `agents/ace-orchestrator.md`

- [ ] **Step 1: Write ace-orchestrator agent definition**

File: `agents/ace-orchestrator.md`

```markdown
---
name: ace-orchestrator
description: >
  Top-level ACE orchestrator. Dispatches to phase agents to run the full
  CRISPR-Connect lifecycle for a Connect opportunity. Supports auto and
  review modes. Use when running a full opportunity cycle or checking
  overall status.
model: inherit
---

# ACE Orchestrator

You are ACE — the AI Connect Engine. You orchestrate the full CRISPR-Connect lifecycle
for Connect opportunities, from idea through app building, deployment, LLO management,
and closeout.

## Your State

Opportunity state lives in Google Drive under `ACE/<opp-name>/`. Use the Google Drive
MCP tools (`sheets_read`, `drive_read_file`, `drive_list_folder`, etc.) to read and
write state.

The state file at `ACE/<opp-name>/state.yaml` tracks:
- Current phase and step
- Mode (auto or review)
- Timestamps for each completed step
- Gate approvals (who approved, when)
- Any errors or manual interventions

## Execution Modes

**Auto mode:** Run all phases sequentially. Email the CRISPR Admin group
(Neal, Jon, Matt, Sarvesh, Cal) at each step completion and on failures.
Gates are logged but not enforced.

**Review mode:** Run all phases sequentially but pause at gate steps.
Use AskUserQuestion to present results and get approval before proceeding.
Gate steps are:
- After idea-to-idd (IDD must be approved before building apps)
- After app-deploy (apps must be verified before publishing)
- After llo-invite (invites must be reviewed before sending)

## Workflow

When invoked with an opportunity, execute these phases in order:

### Phase 1: App Building
Dispatch to the **app-builder** agent with the opportunity context.
This phase produces: IDD, Learn app, Deliver app, deployed apps, test results,
training materials.

### Phase 2: Connect Setup
Dispatch to the **connect-setup** agent.
This phase produces: Program configured, Opportunity configured with verification
rules and delivery/payment units, LLO invitations sent.

### Phase 3: LLO Management
Dispatch to the **llo-manager** agent.
This phase produces: LLOs onboarded, OCS agent configured, ongoing monitoring
active. This phase has recurring skills (timeline-monitor, flw-data-review) that
run on schedule during the active opportunity.

### Phase 4: Closeout
Dispatch to the **closeout** agent. Triggered when the opportunity reaches its
end date.
This phase produces: Invoices pulled, Jira payment ticket created, LLO feedback
collected, learnings summarized, cycle graded.

## Between Phases

After each phase completes:
1. Update `state.yaml` in the opportunity's GDrive folder
2. In auto mode: send status email to admin group
3. In review mode: present summary and wait for approval to continue

## Error Handling

If a skill fails:
1. Log the error in `state.yaml`
2. In auto mode: email the admin group with error details, continue to next step if possible
3. In review mode: present the error and ask how to proceed (retry, skip, abort)

## Starting a New Opportunity

When starting fresh:
1. Create the opportunity folder in GDrive: `ACE/<opp-name>/`
2. Initialize `state.yaml` with mode, start time, all steps as "pending"
3. Begin Phase 1
```

- [ ] **Step 2: Commit**

```bash
git add agents/ace-orchestrator.md
git commit -m "feat: add ace-orchestrator agent definition"
```

---

### Task 4: App-Builder Agent and Skills

The app-builder agent orchestrates: idea → IDD → Nova apps → deploy → test → training materials.

**Files:**
- Create: `agents/app-builder.md`
- Create: `skills/idea-to-idd/SKILL.md`
- Create: `skills/idd-to-learn-app/SKILL.md`
- Create: `skills/idd-to-deliver-app/SKILL.md`
- Create: `skills/app-deploy/SKILL.md`
- Create: `skills/app-test/SKILL.md`
- Create: `skills/training-materials/SKILL.md`

- [ ] **Step 1: Write app-builder agent definition**

File: `agents/app-builder.md`

```markdown
---
name: app-builder
description: >
  Orchestrates the app building phase of CRISPR-Connect: idea iteration into
  an IDD, passing the IDD to Nova for Learn and Deliver apps, deploying to
  CCHQ, testing, and creating training materials.
model: inherit
---

# App Builder Agent

You orchestrate the app building phase of a CRISPR-Connect opportunity.

## Workflow

Execute these steps in order for the given opportunity:

### Step 1: Idea to IDD
Invoke the `idea-to-idd` skill.
- Input: initial idea (from Neal or the opportunity brief)
- Output: `ACE/<opp-name>/idd.md` written to GDrive
- **Gate (review mode):** Present IDD for approval before continuing
- **LLM-as-Judge:** Evaluate IDD quality (completeness, feasibility, clarity)

### Step 2: IDD to Apps (parallel)
Invoke `idd-to-learn-app` and `idd-to-deliver-app` skills. These can run in parallel.
- Input: approved IDD from GDrive
- Output: app JSON/CCZ files + summaries written to `ACE/<opp-name>/app-summaries/`
- **LLM-as-Judge:** Evaluate app quality against IDD requirements

### Step 3: Deploy Apps
Invoke the `app-deploy` skill.
- Input: app JSON/CCZ files from GDrive
- Output: apps uploaded to CCHQ CRISPR-Connect domain, built and published
- **Gate (review mode):** Present app deployment summary for verification

### Step 4: Test and Train (parallel)
Invoke `app-test` and `training-materials` skills. These can run in parallel.
- `app-test` input: deployed apps on CCHQ
- `app-test` output: test results in `ACE/<opp-name>/test-results/`
- `training-materials` input: app summaries from GDrive
- `training-materials` output: training docs in `ACE/<opp-name>/training-materials/`
- **LLM-as-Judge:** Both skills self-evaluate quality

### Completion
Update opportunity state to mark app-building phase as complete.
Write phase summary to `ACE/<opp-name>/app-building-summary.md`.
```

- [ ] **Step 2: Write idea-to-idd skill**

File: `skills/idea-to-idd/SKILL.md`

```markdown
---
name: idea-to-idd
description: >
  Iterate on an idea to produce a well-specified Intervention Design Doc (IDD)
  for a Connect application. Defines the intervention, target FLWs, visit
  structure, and preferred LLOs.
---

# Idea to IDD

Take an initial idea and iterate on it to produce a complete Intervention Design
Doc (IDD) that specifies a Connect application.

## Process

1. **Read the initial idea** from the opportunity folder in GDrive
   (`ACE/<opp-name>/idea.md` or provided as input).

2. **Research and expand** the idea:
   - What health/development problem does this address?
   - What is the intervention mechanism?
   - Who are the target beneficiaries?
   - What data needs to be collected (Learn app)?
   - What services need to be delivered (Deliver app)?

3. **Draft the IDD** with these sections:
   - **Problem Statement** — what problem this solves
   - **Intervention Design** — how the intervention works
   - **Learn App Specification** — what data FLWs collect, visit structure, form design
   - **Deliver App Specification** — what services FLWs deliver, workflow, case management
   - **Target Population** — beneficiary criteria, expected reach
   - **FLW Requirements** — number of FLWs, skills needed, geographic distribution
   - **LLO Preference** — preferred or known LLOs to execute, from LLO Directory
   - **Success Metrics** — how to measure if the intervention worked
   - **Timeline** — expected duration of the opportunity

4. **Self-evaluate (LLM-as-Judge):**
   - Is the IDD complete enough for Nova to generate apps?
   - Are the Learn and Deliver app specs specific enough?
   - Are success metrics measurable?
   - Is the FLW/visit structure realistic?
   If quality is insufficient, iterate on weak sections before outputting.

5. **Write the IDD** to `ACE/<opp-name>/idd.md` via Google Drive MCP.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_update_file`

## Mode Behavior
- **Auto:** Write IDD, email summary to admin group, proceed
- **Review:** Write IDD, present for human review, wait for approval
```

- [ ] **Step 3: Write idd-to-learn-app skill**

File: `skills/idd-to-learn-app/SKILL.md`

```markdown
---
name: idd-to-learn-app
description: >
  Pass an IDD to Nova to generate the Learn app. Answer Nova's configuration
  questions. Output the app JSON/CCZ and a summary of decisions made.
---

# IDD to Learn App

Generate the Learn (data collection) app from the IDD using Nova.

## Process

1. **Read the IDD** from `ACE/<opp-name>/idd.md` via Google Drive MCP.

2. **Extract Learn app requirements** from the IDD:
   - What data needs to be collected?
   - Visit structure and frequency
   - Form design requirements
   - Case management needs

3. **Pass to Nova** for app generation.
   - Provide the Learn app spec section of the IDD
   - Answer Nova's configuration questions based on the IDD
   - Capture all decisions made during configuration

4. **Receive app output** — JSON/CCZ file from Nova.

5. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the IDD Learn spec?
   - Are all required data collection forms present?
   - Is the visit structure correct?
   - Are case properties properly configured?

6. **Write outputs to GDrive:**
   - App JSON/CCZ to `ACE/<opp-name>/apps/learn-app.json`
   - Decision summary to `ACE/<opp-name>/app-summaries/learn-app-summary.md`

7. **Notify admin group** that Learn app generation is complete, with link to summary.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Nova: TBD — see `playbook/integrations/nova-integration.md`

## Current Workaround (Nova not yet integrated)
1. Generate a structured app brief from the IDD Learn spec
2. Write it to `ACE/<opp-name>/app-briefs/learn-app-brief.md`
3. Ask the user to create the app in Nova using this brief
4. Ask the user to upload the resulting JSON/CCZ to the GDrive folder
5. Proceed to write the app summary from the uploaded file

## Mode Behavior
- **Auto:** Generate app (or brief), notify admin group, proceed
- **Review:** Present app summary for review before proceeding
```

- [ ] **Step 4: Write idd-to-deliver-app skill**

File: `skills/idd-to-deliver-app/SKILL.md`

```markdown
---
name: idd-to-deliver-app
description: >
  Pass an IDD to Nova to generate the Deliver app. Answer Nova's configuration
  questions. Output the app JSON/CCZ and a summary of decisions made.
---

# IDD to Deliver App

Generate the Deliver (service delivery) app from the IDD using Nova.

## Process

1. **Read the IDD** from `ACE/<opp-name>/idd.md` via Google Drive MCP.

2. **Extract Deliver app requirements** from the IDD:
   - What services need to be delivered?
   - Workflow and case management
   - Verification criteria
   - Payment triggers

3. **Pass to Nova** for app generation.
   - Provide the Deliver app spec section of the IDD
   - Answer Nova's configuration questions based on the IDD
   - Capture all decisions made during configuration

4. **Receive app output** — JSON/CCZ file from Nova.

5. **Self-evaluate (LLM-as-Judge):**
   - Does the app structure match the IDD Deliver spec?
   - Are all service delivery forms present?
   - Is the case management workflow correct?
   - Are verification criteria properly encoded?

6. **Write outputs to GDrive:**
   - App JSON/CCZ to `ACE/<opp-name>/apps/deliver-app.json`
   - Decision summary to `ACE/<opp-name>/app-summaries/deliver-app-summary.md`

7. **Notify admin group** that Deliver app generation is complete.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Nova: TBD — see `playbook/integrations/nova-integration.md`

## Current Workaround (Nova not yet integrated)
1. Generate a structured app brief from the IDD Deliver spec
2. Write it to `ACE/<opp-name>/app-briefs/deliver-app-brief.md`
3. Ask the user to create the app in Nova using this brief
4. Ask the user to upload the resulting JSON/CCZ to the GDrive folder
5. Proceed to write the app summary from the uploaded file

## Mode Behavior
- **Auto:** Generate app (or brief), notify admin group, proceed
- **Review:** Present app summary for review before proceeding
```

- [ ] **Step 5: Write app-deploy skill**

File: `skills/app-deploy/SKILL.md`

```markdown
---
name: app-deploy
description: >
  Upload Learn and Deliver app JSONs to the CRISPR-Connect domain on CommCare HQ,
  build, and publish the apps.
---

# App Deploy

Upload the generated Learn and Deliver apps to CommCare HQ and publish them.

## Process

1. **Read app files** from `ACE/<opp-name>/apps/` via Google Drive MCP.

2. **Upload to CCHQ:**
   - Target domain: CRISPR-Connect domain (pre-configured with feature flags and API keys)
   - Upload Learn app JSON
   - Upload Deliver app JSON

3. **Build apps** on CCHQ — trigger the build process for both apps.

4. **Publish apps** — make them available for mobile deployment.

5. **Write deployment summary** to `ACE/<opp-name>/deployment-summary.md`:
   - App IDs on CCHQ
   - Build status
   - Published URLs
   - Domain and project details

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- CommCare: TBD — app upload API or CommCare CLI wrapper

## Current Workaround (CommCare app upload not yet automated)
1. Read the app JSON/CCZ files from GDrive
2. Provide the user with:
   - The CRISPR-Connect domain URL
   - Instructions to upload each app via the HQ UI
   - What settings to verify after upload
3. Ask the user to confirm both apps are uploaded and built
4. Write the deployment summary with the app IDs the user provides

## Mode Behavior
- **Auto:** Deploy (or guide manual deploy), notify admin group, proceed
- **Review:** Present deployment summary, wait for verification before proceeding
```

- [ ] **Step 6: Write app-test skill**

File: `skills/app-test/SKILL.md`

```markdown
---
name: app-test
description: >
  Create and execute an automated test plan for the Learn and Deliver apps.
  Identify bugs and issues before LLO deployment.
---

# App Test

Create a test plan and execute it against the deployed Learn and Deliver apps.

## Process

1. **Read app summaries** from `ACE/<opp-name>/app-summaries/` via Google Drive MCP.

2. **Read deployment details** from `ACE/<opp-name>/deployment-summary.md`.

3. **Generate test plan** based on app structure:
   - Form completion flows (every form, every path)
   - Case management (create, update, close)
   - Skip logic and validation rules
   - Required fields and constraints
   - Edge cases (empty inputs, max lengths, special characters)
   - Cross-form data flow (does data from Learn appear correctly in Deliver?)

4. **Execute tests** using available tools:
   - Use CommCare MCP to inspect app structure and form questions
   - Use browse/gstack for UI testing if web app preview is available
   - Document each test case: input, expected output, actual output, pass/fail

5. **Self-evaluate (LLM-as-Judge):**
   - Is test coverage sufficient? (all forms, all case types, key validation rules)
   - Are any critical paths untested?
   - Are identified bugs real issues or false positives?

6. **Write test results** to `ACE/<opp-name>/test-results/`:
   - `test-plan.md` — the full test plan
   - `test-results.md` — pass/fail for each test case
   - `bugs.md` — list of identified bugs with severity and repro steps

7. **Notify admin group** with test summary (pass rate, critical bugs found).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- CommCare (connect-labs): `get_app_structure`, `get_form_questions`

## Mode Behavior
- **Auto:** Run tests, write results, notify admin group, proceed
- **Review:** Present test results and any critical bugs for review
```

- [ ] **Step 7: Write training-materials skill**

File: `skills/training-materials/SKILL.md`

```markdown
---
name: training-materials
description: >
  Generate training materials for LLOs and FLWs from app summaries and
  template collateral. Output guides, quick-reference cards, and onboarding docs.
---

# Training Materials

Generate training materials from the app summaries and standard templates.

## Process

1. **Read inputs from GDrive:**
   - IDD: `ACE/<opp-name>/idd.md`
   - Learn app summary: `ACE/<opp-name>/app-summaries/learn-app-summary.md`
   - Deliver app summary: `ACE/<opp-name>/app-summaries/deliver-app-summary.md`
   - Template collateral from `templates/` directory (if available)

2. **Generate training materials:**
   - **LLO Manager Guide** — overview of the opportunity, what LLOs need to do,
     timeline, expectations, escalation contacts
   - **FLW Training Guide** — step-by-step instructions for using the Learn and
     Deliver apps, with screenshots/descriptions of each form
   - **Quick Reference Card** — one-page summary of key workflows, common issues,
     and support contacts
   - **FAQ** — anticipated questions from LLOs and FLWs based on the app design

3. **Self-evaluate (LLM-as-Judge):**
   - Are instructions clear enough for someone with no prior context?
   - Do the materials match the actual app structure?
   - Are all key workflows covered?
   - Is the language appropriate for the target audience?

4. **Write to GDrive:** `ACE/<opp-name>/training-materials/`
   - `llo-manager-guide.md`
   - `flw-training-guide.md`
   - `quick-reference.md`
   - `faq.md`

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`

## Mode Behavior
- **Auto:** Generate materials, notify admin group, proceed
- **Review:** Present materials for review before distributing to LLOs
```

- [ ] **Step 8: Commit**

```bash
git add agents/app-builder.md skills/idea-to-idd/ skills/idd-to-learn-app/ skills/idd-to-deliver-app/ skills/app-deploy/ skills/app-test/ skills/training-materials/
git commit -m "feat: add app-builder agent and 6 skills (idea-to-idd through training-materials)"
```

---

### Task 5: Connect-Setup Agent and Skills

**Files:**
- Create: `agents/connect-setup.md`
- Create: `skills/connect-program-setup/SKILL.md`
- Create: `skills/connect-opp-setup/SKILL.md`
- Create: `skills/llo-invite/SKILL.md`

- [ ] **Step 1: Write connect-setup agent definition**

File: `agents/connect-setup.md`

```markdown
---
name: connect-setup
description: >
  Orchestrates Connect platform setup for a CRISPR-Connect opportunity:
  program creation, opportunity configuration, and LLO invitations.
model: inherit
---

# Connect Setup Agent

You set up the Connect platform for a CRISPR-Connect opportunity.

## Workflow

Execute these steps in order:

### Step 1: Program Setup
Invoke the `connect-program-setup` skill.
- Input: IDD and opportunity details from GDrive
- Output: Program created/configured in Connect
- Note: may not need a new program each time — check if existing program fits

### Step 2: Opportunity Setup
Invoke the `connect-opp-setup` skill.
- Input: Program ID, IDD, app deployment details
- Output: Opportunity created with verification rules, delivery units, payment units
- Depends on: Step 1 (needs Program ID)

### Step 3: LLO Invitations
Invoke the `llo-invite` skill.
- Input: Opportunity ID, LLO preferences from IDD
- Output: LLO contacts identified and invited
- **Gate (review mode):** Present invite list for approval before sending
- Depends on: Step 2 (needs Opportunity ID)

### Completion
Update opportunity state. Write phase summary to
`ACE/<opp-name>/connect-setup-summary.md`.
```

- [ ] **Step 2: Write connect-program-setup skill**

File: `skills/connect-program-setup/SKILL.md`

```markdown
---
name: connect-program-setup
description: >
  Create or configure a Program in Connect for the CRISPR-Connect opportunity.
  Checks if an existing program fits before creating a new one.
---

# Connect Program Setup

Create or select a Connect program for this opportunity.

## Process

1. **Read the IDD** from `ACE/<opp-name>/idd.md`.

2. **Check for existing programs** that match this opportunity's domain/scope.
   Use connect-labs MCP `list_solicitations` or similar to browse existing programs.

3. **Decide: reuse or create**
   - If an existing program fits, note the program ID
   - If not, create a new program with appropriate name, description, and config

4. **Write program details** to `ACE/<opp-name>/connect-setup/program.md`:
   - Program ID
   - Program name
   - Whether reused or newly created
   - Configuration details

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (connect-labs): existing solicitation tools for discovery
- Connect: `create_program` — **NOT YET BUILT** (CCC-301)

## Current Workaround
1. Read the IDD and determine program requirements
2. Ask the user: "Does an existing Connect program fit this opportunity, or should we create a new one?"
3. If new: provide the user with the recommended program name and configuration
4. Ask the user to create it in the Connect UI and provide the Program ID
5. Record the Program ID in the opportunity folder

## Mode Behavior
- **Auto:** Create program (or guide manual creation), proceed
- **Review:** Present program choice for approval
```

- [ ] **Step 3: Write connect-opp-setup skill**

File: `skills/connect-opp-setup/SKILL.md`

```markdown
---
name: connect-opp-setup
description: >
  Create and configure an Opportunity in Connect — including verification rules,
  delivery units, payment units, and all other configuration needed for the opp.
---

# Connect Opportunity Setup

Create and fully configure a Connect opportunity.

## Process

1. **Read inputs from GDrive:**
   - IDD: `ACE/<opp-name>/idd.md`
   - Program details: `ACE/<opp-name>/connect-setup/program.md`
   - App deployment details: `ACE/<opp-name>/deployment-summary.md`

2. **Create the Opportunity** in Connect:
   - Name from IDD
   - Link to Program from previous step
   - Delivery type: "Experiment" (generic type) or appropriate type
   - Start/end dates from IDD timeline
   - Link to CCHQ apps

3. **Configure verification rules:**
   - Based on IDD success metrics and Deliver app structure
   - Map verification criteria to form submissions / case properties

4. **Configure delivery units:**
   - Based on IDD intervention design (visits, services, etc.)
   - Set expected quantities and timelines

5. **Configure payment units:**
   - Based on delivery units and budget from IDD
   - Set payment rates and schedules

6. **Write config summary** to `ACE/<opp-name>/connect-setup/opportunity.md`:
   - Opportunity ID and URL
   - All configuration details
   - Verification rules
   - Delivery and payment unit setup

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: `create_opportunity`, `set_verification_rules`, `set_delivery_units`, `set_payment_units` — **NOT YET BUILT** (CCC-301)

## Current Workaround
1. Read IDD and determine all configuration requirements
2. Generate a complete configuration spec document
3. Write it to `ACE/<opp-name>/connect-setup/opp-config-spec.md`
4. Ask the user to create the opportunity in Connect UI following the spec
5. Ask for the Opportunity ID and URL
6. Record in the opportunity folder

## Mode Behavior
- **Auto:** Configure (or guide manual config), proceed
- **Review:** Present configuration spec for approval before creating
```

- [ ] **Step 4: Write llo-invite skill**

File: `skills/llo-invite/SKILL.md`

```markdown
---
name: llo-invite
description: >
  Look up LLO contacts from the LLO Directory and invite them to the
  Connect opportunity.
---

# LLO Invite

Identify and invite LLOs to participate in the opportunity.

## Process

1. **Read inputs from GDrive:**
   - IDD: `ACE/<opp-name>/idd.md` (LLO preferences section)
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`

2. **Look up LLO contacts:**
   - Check IDD for preferred/known LLOs
   - Search LLO Directory for matching organizations
   - Get contact details for each LLO

3. **Prepare invite list:**
   - LLO name, contact person, email
   - Why this LLO was selected (geographic match, capability match, etc.)
   - Opportunity summary for the invite

4. **Send invitations** via Connect invite API.

5. **Write invite log** to `ACE/<opp-name>/connect-setup/invites.md`:
   - Who was invited
   - When invites were sent
   - Status of each invite

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: `list_llo_contacts`, `send_invite` — **NOT YET BUILT**

## Current Workaround
1. Read the IDD's LLO preference section
2. Generate a recommended invite list with rationale
3. Write to `ACE/<opp-name>/connect-setup/recommended-invites.md`
4. Ask the user to review the list and send invites through the Connect UI
5. Ask for confirmation of which LLOs were invited
6. Update the invite log

## Mode Behavior
- **Auto:** Send invites (or guide manual invites), notify admin group
- **Review:** Present invite list for approval before sending (this is a gate step)
```

- [ ] **Step 5: Commit**

```bash
git add agents/connect-setup.md skills/connect-program-setup/ skills/connect-opp-setup/ skills/llo-invite/
git commit -m "feat: add connect-setup agent and 3 skills (program, opp, invites)"
```

---

### Task 6: LLO-Manager Agent and Skills

**Files:**
- Create: `agents/llo-manager.md`
- Create: `skills/llo-onboarding/SKILL.md`
- Create: `skills/ocs-agent-setup/SKILL.md`
- Create: `skills/timeline-monitor/SKILL.md`
- Create: `skills/flw-data-review/SKILL.md`

- [ ] **Step 1: Write llo-manager agent definition**

File: `agents/llo-manager.md`

```markdown
---
name: llo-manager
description: >
  Orchestrates LLO management during an active opportunity: onboarding,
  OCS agent setup, timeline monitoring, and FLW data review. Includes
  recurring skills that run on schedule.
model: inherit
---

# LLO Manager Agent

You manage LLO relationships during an active CRISPR-Connect opportunity.

## Workflow

### Step 1: LLO Onboarding
Invoke the `llo-onboarding` skill.
- Input: invite list, training materials from GDrive
- Output: onboarding emails sent to LLOs with training materials and instructions

### Step 2: OCS Agent Setup
Invoke the `ocs-agent-setup` skill.
- Input: IDD, training materials, opportunity context
- Output: OCS agent configured for this opportunity
- **LLM-as-Judge:** Evaluate agent context quality

### Step 3: Ongoing Monitoring (recurring)
These skills run on a schedule during the active opportunity:

**Timeline Monitor** — invoke `timeline-monitor` skill weekly (or as configured).
- Checks if LLOs are on track with expected milestones
- Sends prompting emails if behind schedule

**FLW Data Review** — invoke `flw-data-review` skill weekly (or as configured).
- Analyzes FLW submission data for quality issues
- Generates recommendations for the Auto-Connect team to relay to LLOs

### Completion
This phase is "complete" when the opportunity reaches its end date.
Ongoing monitoring continues until then.
```

- [ ] **Step 2: Write llo-onboarding skill**

File: `skills/llo-onboarding/SKILL.md`

```markdown
---
name: llo-onboarding
description: >
  Send onboarding emails to invited LLOs with training materials, app
  instructions, and next steps. Uses Ace-AI@Dimagi.com as sender.
---

# LLO Onboarding

Send onboarding communications to LLOs who accepted the opportunity invitation.

## Process

1. **Read inputs from GDrive:**
   - Invite log: `ACE/<opp-name>/connect-setup/invites.md`
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`

2. **For each invited LLO, compose an onboarding email:**
   - From: Ace-AI@Dimagi.com
   - CC: CRISPR Admin Dimagi Google Group
   - Subject: "[Opportunity Name] — Welcome and Next Steps"
   - Body:
     - Welcome and opportunity overview
     - Links to training materials (GDrive links or attachments)
     - Step-by-step instructions for getting started
     - Timeline and expectations
     - How to ask questions (email Ace-AI@Dimagi.com — handled by OCS)
     - Contact info for escalation

3. **Send emails** (or draft for review).

4. **Log communications** to `ACE/<opp-name>/comms-log/onboarding-emails.md`.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`

## Current Workaround
1. Generate the email content for each LLO
2. Write drafts to `ACE/<opp-name>/comms-log/onboarding-drafts/`
3. Ask the user to send the emails from Ace-AI@Dimagi.com
4. Update the comms log with send confirmation

## Mode Behavior
- **Auto:** Send emails directly, log to GDrive
- **Review:** Present email drafts for review before sending
```

- [ ] **Step 3: Write ocs-agent-setup skill**

File: `skills/ocs-agent-setup/SKILL.md`

```markdown
---
name: ocs-agent-setup
description: >
  Configure an OCS agent for this opportunity. Inject the IDD, training
  materials, and opportunity context so OCS can answer LLO questions.
---

# OCS Agent Setup

Create and configure an OCS agent that handles LLO questions for this opportunity.

## Process

1. **Read context from GDrive:**
   - IDD: `ACE/<opp-name>/idd.md`
   - Training materials: `ACE/<opp-name>/training-materials/`
   - Opportunity details: `ACE/<opp-name>/connect-setup/opportunity.md`
   - App summaries: `ACE/<opp-name>/app-summaries/`

2. **Compose agent context document:**
   Combine all relevant information into a structured context that tells
   the OCS agent:
   - What this opportunity is about (from IDD)
   - How the apps work (from app summaries)
   - What LLOs need to know (from training materials)
   - Key dates and milestones (from opportunity details)
   - Escalation rules (when to cc the admin group)

3. **Create/configure OCS agent** via OCS MCP:
   - Name: "ACE - [Opportunity Name]"
   - Email: Ace-AI@Dimagi.com
   - Context: the composed document
   - Rules: always CC admin group on responses

4. **Self-evaluate (LLM-as-Judge):**
   - Is the context comprehensive enough to answer typical LLO questions?
   - Are escalation rules clear?
   - Does the agent have enough detail about the apps and workflows?

5. **Write agent config** to `ACE/<opp-name>/ocs-agent-config.md`:
   - Agent ID
   - Context summary
   - Configuration details

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- OCS: `ocs_create_agent`, `ocs_update_context` — **NOT YET BUILT**

## Current Workaround
1. Generate the complete agent context document
2. Write it to `ACE/<opp-name>/ocs-context.md`
3. Ask the user to configure the OCS agent manually with this context
4. Ask for the agent ID and record it

## Mode Behavior
- **Auto:** Configure agent (or guide manual config), proceed
- **Review:** Present agent context for review before configuring
```

- [ ] **Step 4: Write timeline-monitor skill**

File: `skills/timeline-monitor/SKILL.md`

```markdown
---
name: timeline-monitor
description: >
  Monitor whether LLOs are hitting expected milestones on schedule.
  Send prompting emails if behind. Runs recurring during active opp.
---

# Timeline Monitor

Check LLO progress against expected timeline and prompt action if behind.

## Process (runs periodically)

1. **Read opportunity state** from GDrive:
   - Timeline/milestones from IDD
   - Current status from `ACE/<opp-name>/state.yaml`
   - Previous monitoring reports from `ACE/<opp-name>/monitoring/`

2. **Check progress indicators:**
   - Have LLOs started onboarding FLWs?
   - Are FLWs submitting forms in the expected timeframe?
   - Are delivery targets on track?
   - Use Connect opportunity status and CommCare submission data

3. **Self-evaluate (LLM-as-Judge):**
   - Is the assessment accurate given the data available?
   - Are the recommendations actionable?
   - Is the tone appropriate for LLO communication?

4. **If behind schedule:**
   - Draft a prompting email to the LLO via Ace-AI@Dimagi.com
   - Include specific areas of concern and suggested actions
   - CC admin group

5. **Write monitoring report** to `ACE/<opp-name>/monitoring/YYYY-MM-DD-timeline-check.md`.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect (connect-labs): `get_opportunity_apps`, opportunity status queries
- CommCare (connect-labs/scout-data): form submission queries for FLW activity

## Mode Behavior
- **Auto:** Check timeline, send prompting emails if needed, log report
- **Review:** Present findings and draft emails for approval before sending
```

- [ ] **Step 5: Write flw-data-review skill**

File: `skills/flw-data-review/SKILL.md`

```markdown
---
name: flw-data-review
description: >
  Analyze FLW submission data to identify quality issues, trends, and
  improvement opportunities. Generate recommendations for the team.
  Runs recurring during active opp.
---

# FLW Data Review

Analyze FLW data and recommend improvements to communicate to LLOs.

## Process (runs periodically)

1. **Read opportunity context** from GDrive:
   - App summaries and expected data patterns
   - Previous data reviews from `ACE/<opp-name>/data-reviews/`
   - IDD success metrics

2. **Query FLW data** via scout-data MCP:
   - Form submission rates by FLW
   - Completion rates and dropout patterns
   - Data quality issues (missing fields, outlier values)
   - Case management compliance
   - Compare against expected metrics from IDD

3. **Self-evaluate (LLM-as-Judge):**
   - Are the identified patterns real signals or noise?
   - Are recommendations specific enough to act on?
   - Is the analysis grounded in data, not speculation?

4. **Generate recommendations:**
   - Specific issues identified (with data evidence)
   - Suggested actions for the Auto-Connect team to relay to LLOs
   - Trends over time (improving, declining, stable)

5. **Write data review** to `ACE/<opp-name>/data-reviews/YYYY-MM-DD-review.md`.

6. **Notify admin group** with summary of findings and recommendations.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- CommCare (scout-data): `query`, `list_tables`, `describe_table`
- Connect (connect-labs): `get_opportunity_apps` for app IDs

## Mode Behavior
- **Auto:** Analyze data, write report, email recommendations to admin group
- **Review:** Present findings and recommendations for team discussion
```

- [ ] **Step 6: Commit**

```bash
git add agents/llo-manager.md skills/llo-onboarding/ skills/ocs-agent-setup/ skills/timeline-monitor/ skills/flw-data-review/
git commit -m "feat: add llo-manager agent and 4 skills (onboarding, OCS, monitoring, data review)"
```

---

### Task 7: Closeout Agent and Skills

**Files:**
- Create: `agents/closeout.md`
- Create: `skills/opp-closeout/SKILL.md`
- Create: `skills/llo-feedback/SKILL.md`
- Create: `skills/learnings-summary/SKILL.md`
- Create: `skills/cycle-grade/SKILL.md`

- [ ] **Step 1: Write closeout agent definition**

File: `agents/closeout.md`

```markdown
---
name: closeout
description: >
  Orchestrates opportunity closeout: invoice processing, LLO feedback
  collection, learnings summary, and overall cycle grading. Triggered
  when the opportunity reaches its end date.
model: inherit
---

# Closeout Agent

You handle the closeout of a completed CRISPR-Connect opportunity.

## Workflow

### Step 1: Invoice and Payment
Invoke the `opp-closeout` skill.
- Input: opportunity details, invoice data
- Output: invoices pulled, Jira payment ticket created

### Step 2: LLO Feedback
Invoke the `llo-feedback` skill.
- Input: LLO contact info, opportunity context
- Output: feedback collected and documented

### Step 3: Learnings Summary
Invoke the `learnings-summary` skill.
- Input: feedback, data reviews, monitoring reports, OCS transcripts
- Output: comprehensive learnings doc, potentially a new IDD for iteration
- Depends on: Steps 1 and 2

### Step 4: Cycle Grade
Invoke the `cycle-grade` skill.
- Input: all opportunity artifacts and outcomes
- Output: overall grade with recommendations
- **LLM-as-Judge:** Self-evaluate grading quality
- Depends on: Step 3

### Completion
Update opportunity state to "closed". Write final summary to
`ACE/<opp-name>/closeout/final-summary.md`.
Email admin group with closeout report.
```

- [ ] **Step 2: Write opp-closeout skill**

File: `skills/opp-closeout/SKILL.md`

```markdown
---
name: opp-closeout
description: >
  Pull invoices from the completed opportunity and create a Jira ticket
  to issue payment to the LLO.
---

# Opportunity Closeout

Process the financial closeout of a completed opportunity.

## Process

1. **Read opportunity details** from GDrive:
   - Opportunity config: `ACE/<opp-name>/connect-setup/opportunity.md`
   - Delivery/payment unit config

2. **Pull invoices** from Connect for this opportunity.
   - Get auto-generated invoices based on verified deliveries
   - Calculate total payment amount

3. **Create Jira ticket** for payment processing:
   - Project: appropriate Jira project for Connect payments
   - Summary: "Payment: [Opportunity Name] — [LLO Name]"
   - Description: invoice details, amount, LLO banking info reference
   - Attach invoice documents

4. **Write closeout record** to `ACE/<opp-name>/closeout/invoices.md`:
   - Invoice details
   - Total amount
   - Jira ticket link

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- Connect: invoice pull API — **NOT YET BUILT**
- Jira (Atlassian MCP): `createJiraIssue`

## Current Workaround
1. Read opportunity details and calculate expected payment
2. Document the invoice expectations
3. Ask the user to pull invoices from Connect UI
4. Ask the user to create the Jira payment ticket (or use Atlassian MCP if available)
5. Record the details

## Mode Behavior
- **Auto:** Pull invoices, create Jira ticket, proceed
- **Review:** Present invoice details for verification before creating ticket
```

- [ ] **Step 3: Write llo-feedback skill**

File: `skills/llo-feedback/SKILL.md`

```markdown
---
name: llo-feedback
description: >
  Prompt LLOs for feedback about the application, process, and suggestions
  for next steps. Collect and document responses.
---

# LLO Feedback

Collect feedback from LLOs about the completed opportunity.

## Process

1. **Read opportunity context** from GDrive:
   - LLO contact info from invite/comms logs
   - Opportunity summary
   - Key metrics (delivery rates, issues encountered)

2. **Compose feedback request email:**
   - From: Ace-AI@Dimagi.com
   - CC: admin group
   - Ask about:
     - Application usability (Learn and Deliver apps)
     - Process experience (onboarding, support, communication)
     - FLW experience and challenges
     - Suggestions for improvement
     - Interest in future opportunities

3. **Send feedback request** to each LLO.

4. **Monitor for responses** via OCS transcripts or email.

5. **Document feedback** to `ACE/<opp-name>/closeout/llo-feedback.md`:
   - Responses from each LLO
   - Common themes
   - Specific improvement suggestions

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`
- OCS: `ocs_list_transcripts` for monitoring responses

## Current Workaround
1. Generate feedback request email drafts
2. Write to `ACE/<opp-name>/closeout/feedback-request-drafts/`
3. Ask user to send and collect responses
4. Document responses when provided

## Mode Behavior
- **Auto:** Send feedback requests, monitor and document responses
- **Review:** Present email drafts for review before sending
```

- [ ] **Step 4: Write learnings-summary skill**

File: `skills/learnings-summary/SKILL.md`

```markdown
---
name: learnings-summary
description: >
  Summarize learnings from the completed opportunity and create a new IDD
  if iteration is warranted. Can trigger another CRISPR-Connect cycle.
---

# Learnings Summary

Synthesize all information from the completed opportunity into actionable learnings.

## Process

1. **Read all opportunity artifacts from GDrive:**
   - IDD (original plan)
   - Test results
   - Monitoring reports from `ACE/<opp-name>/monitoring/`
   - Data reviews from `ACE/<opp-name>/data-reviews/`
   - OCS transcripts (LLO questions and issues)
   - LLO feedback from `ACE/<opp-name>/closeout/llo-feedback.md`
   - Comms log

2. **Analyze against original IDD:**
   - What worked as designed?
   - What didn't work or needed adjustment?
   - Were success metrics met?
   - What was unexpected?

3. **Synthesize learnings:**
   - **Process learnings** — what to change about the CRISPR-Connect process itself
   - **Content learnings** — what to change about the intervention design
   - **Technical learnings** — what to change about the apps or configuration
   - **Relationship learnings** — what to change about LLO engagement

4. **Determine if iteration is warranted:**
   - If yes, draft a new IDD incorporating the learnings
   - This new IDD can trigger another CRISPR-Connect cycle

5. **Write to GDrive:**
   - `ACE/<opp-name>/closeout/learnings.md` — full learnings document
   - `ACE/<opp-name>/closeout/new-idd.md` — new IDD if iteration warranted

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`
- OCS: `ocs_list_transcripts`, `ocs_get_transcript`

## Mode Behavior
- **Auto:** Generate learnings, create new IDD if warranted, notify admin group
- **Review:** Present learnings and new IDD for team discussion
```

- [ ] **Step 5: Write cycle-grade skill**

File: `skills/cycle-grade/SKILL.md`

```markdown
---
name: cycle-grade
description: >
  Grade the overall CRISPR-Connect cycle with recommendations for
  improvements and next steps.
---

# Cycle Grade

Produce a final grade and assessment of the complete CRISPR-Connect cycle.

## Process

1. **Read all opportunity artifacts from GDrive**, including learnings summary.

2. **Grade across dimensions:**
   - **Intervention Effectiveness** (0-10) — did the intervention achieve its goals?
   - **App Quality** (0-10) — were the Learn/Deliver apps well-designed and functional?
   - **LLO Execution** (0-10) — did LLOs execute effectively?
   - **FLW Performance** (0-10) — did FLWs deliver quality data/services?
   - **Process Efficiency** (0-10) — how smoothly did the CRISPR-Connect process run?
   - **Communication Quality** (0-10) — was communication with LLOs effective?
   - **Overall Grade** — weighted average with narrative assessment

3. **Self-evaluate (LLM-as-Judge):**
   - Is the grading fair and evidence-based?
   - Are the recommendations actionable?
   - Does the grade accurately reflect the opportunity's outcomes?

4. **Generate recommendations:**
   - Top 3 things that went well (keep doing)
   - Top 3 things to improve (for next cycle)
   - Specific recommendations for each ACE skill that was used

5. **Write final report** to `ACE/<opp-name>/closeout/cycle-grade.md`.

6. **Email admin group** with the full cycle grade report.

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`

## Mode Behavior
- **Auto:** Generate grade, email report, mark opportunity as closed
- **Review:** Present grade for team review and discussion
```

- [ ] **Step 6: Commit**

```bash
git add agents/closeout.md skills/opp-closeout/ skills/llo-feedback/ skills/learnings-summary/ skills/cycle-grade/
git commit -m "feat: add closeout agent and 4 skills (invoicing, feedback, learnings, grading)"
```

---

### Task 8: Commands

**Files:**
- Create: `commands/run.md`
- Create: `commands/step.md`
- Create: `commands/status.md`
- Create: `commands/docs.md`

- [ ] **Step 1: Write run command**

File: `commands/run.md`

```markdown
---
description: Run the full CRISPR-Connect lifecycle for an opportunity
argument-hint: [<opp-name> --mode auto|review]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:run

Run the full CRISPR-Connect lifecycle for a Connect opportunity.

## Arguments
- `<opp-name>` — name of the opportunity (used as the GDrive folder name)
- `--mode auto|review` — execution mode (default: review)

## Process

1. Parse arguments. Default mode is `review` if not specified.

2. Dispatch to the **ace-orchestrator** agent with:
   - Opportunity name
   - Execution mode
   - Any existing state from GDrive (if resuming)

The orchestrator handles all phases from there.
```

- [ ] **Step 2: Write step command**

File: `commands/step.md`

```markdown
---
description: Run a single step of the CRISPR-Connect process for an opportunity
argument-hint: [<skill-name> <opp-name>]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:step

Run a single skill for an opportunity without running the full lifecycle.

## Arguments
- `<skill-name>` — name of the skill to invoke (e.g., `idea-to-idd`, `app-test`)
- `<opp-name>` — name of the opportunity

## Process

1. Parse arguments.
2. Verify the opportunity folder exists in GDrive (`ACE/<opp-name>/`).
3. Invoke the specified skill with the opportunity context.
4. Update `state.yaml` with the result.

Useful for re-running a specific step, testing a skill in isolation,
or manually advancing through the process.
```

- [ ] **Step 3: Write status command**

File: `commands/status.md`

```markdown
---
description: Show the current status of an opportunity or list all active opportunities
argument-hint: [<opp-name>]
allowed-tools: [Read, Bash, Glob, Grep]
---

# /ace:status

Show the current status of a CRISPR-Connect opportunity.

## Arguments
- `<opp-name>` (optional) — if provided, show detailed status for this opportunity.
  If omitted, list all active opportunities.

## Process

### List all opportunities (no argument)
1. Use Google Drive MCP to list folders under `ACE/`
2. For each folder, read `state.yaml` to get current phase and step
3. Display summary table:
   ```
   Opportunity    | Phase          | Current Step      | Mode   | Last Updated
   ---------------------------------------------------------------------------
   malaria-pilot  | app-building   | app-test          | review | 2026-04-01
   nutrition-v2   | llo-management | timeline-monitor  | auto   | 2026-03-28
   ```

### Detailed status (with opp-name)
1. Read `ACE/<opp-name>/state.yaml` from GDrive
2. Display:
   - Current phase and step
   - Mode (auto/review)
   - All completed steps with timestamps
   - Pending steps
   - Any gate approvals
   - Errors or manual interventions
   - Links to key artifacts in GDrive
```

- [ ] **Step 4: Write docs command**

File: `commands/docs.md`

```markdown
---
description: Generate a human-readable playbook from agent and skill definitions
allowed-tools: [Read, Write, Glob, Grep, Bash]
---

# /ace:docs

Generate the ACE playbook — a human-readable document that explains the full
CRISPR-Connect process, generated from the actual agent and skill definitions.

## Process

1. **Read all agent definitions** from `agents/`:
   - Extract: name, description, workflow steps, gate points

2. **Read all skill definitions** from `skills/*/SKILL.md`:
   - Extract: name, description, process steps, MCP tools used, mode behavior,
     current workarounds (if any)

3. **Read integration specs** from `playbook/integrations/`:
   - Extract: what's available, what's needed, manual workarounds

4. **Generate playbook** at `docs/generated/playbook.md` with sections:

   ```markdown
   # ACE Playbook — CRISPR-Connect Process

   Generated: [date]

   ## Overview
   [From ace-orchestrator agent description]

   ## Process Flow
   [Sequential list of all steps across all phases, with dependencies and gates]

   ## Phase 1: App Building
   ### Agent: app-builder
   [From agent definition]
   ### Skills
   #### idea-to-idd
   [Summary from SKILL.md]
   ...

   ## Phase 2: Connect Setup
   ...

   ## Phase 3: LLO Management
   ...

   ## Phase 4: Closeout
   ...

   ## External Integrations
   ### Connect API
   [Summary: what's available, what's needed]
   ### CommCare API
   ...
   ### OCS
   ...
   ### Nova
   ...

   ## Current Limitations
   [Auto-generated list of all "Current Workaround" sections from skills]

   ## Skill Reference
   [Quick reference table: skill name, description, MCP tools, LLM-as-Judge]
   ```

5. **Commit** the generated playbook.
```

- [ ] **Step 5: Commit**

```bash
git add commands/
git commit -m "feat: add commands (run, step, status, docs)"
```

---

### Task 9: OCS MCP Server Scaffold

**Files:**
- Create: `mcp/ocs-server.ts`

- [ ] **Step 1: Write OCS MCP server scaffold**

File: `mcp/ocs-server.ts`

```typescript
/**
 * OCS MCP Server for ACE
 *
 * Provides tools for managing OCS agents and reading conversation transcripts.
 * Exposes agent CRUD and transcript access over stdio using the Model Context Protocol.
 *
 * TODO: Connect to actual OCS APIs once endpoints are confirmed.
 * For now, this is a scaffold that documents the intended tool interface.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'ocs',
  version: '0.1.0',
});

// ============================================================================
// Agent Management
// ============================================================================

server.tool(
  'ocs_create_agent',
  'Create a new OCS agent for a Connect opportunity. Configures the agent with IDD context, training materials, and opportunity details.',
  {
    name: z.string().describe('Agent name, e.g. "ACE - Malaria Pilot"'),
    context: z.string().describe('Full context document for the agent (IDD + training + opp details)'),
    email: z.string().optional().describe('Email address the agent responds from (default: ace-ai@dimagi.com)'),
    config: z.string().optional().describe('JSON config for agent behavior (escalation rules, cc list, etc.)'),
  },
  async ({ name, context, email, config }) => {
    // TODO: Implement against actual OCS API
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS agent creation API not yet connected. See playbook/integrations/ocs-integration.md for requirements.',
          intended: { name, contextLength: context.length, email: email || 'ace-ai@dimagi.com' },
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'ocs_update_context',
  'Update an existing OCS agent\'s context/knowledge base. Use when new information becomes available during an opportunity.',
  {
    agentId: z.string().describe('The OCS agent ID'),
    context: z.string().describe('Updated context document'),
  },
  async ({ agentId, context }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS context update API not yet connected.',
          intended: { agentId, contextLength: context.length },
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'ocs_agent_status',
  'Check the health and stats of an OCS agent.',
  {
    agentId: z.string().describe('The OCS agent ID'),
  },
  async ({ agentId }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS agent status API not yet connected.',
          intended: { agentId },
        }, null, 2),
      }],
    };
  },
);

// ============================================================================
// Transcript Access
// ============================================================================

server.tool(
  'ocs_list_transcripts',
  'List conversation transcripts for an OCS agent. Supports filtering by date and LLO.',
  {
    agentId: z.string().describe('The OCS agent ID'),
    since: z.string().optional().describe('ISO date string — only transcripts after this date'),
    lloFilter: z.string().optional().describe('Filter by LLO name or ID'),
  },
  async ({ agentId, since, lloFilter }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS transcript list API not yet connected. APIs exist per design spec — need to map endpoints.',
          intended: { agentId, since, lloFilter },
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'ocs_get_transcript',
  'Get a single conversation transcript by ID.',
  {
    transcriptId: z.string().describe('The transcript ID'),
  },
  async ({ transcriptId }) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'not_implemented',
          message: 'OCS transcript access API not yet connected.',
          intended: { transcriptId },
        }, null, 2),
      }],
    };
  },
);

// ============================================================================
// Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('OCS MCP server error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add OCS MCP to settings**

Update `.claude/settings.local.json` to add the OCS MCP server alongside the Google Drive one:

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "npx",
      "args": ["tsx", "mcp/google-drive-server.ts"],
      "cwd": "/Users/jjackson/emdash-projects/worktrees/new-setup-82b"
    },
    "ocs": {
      "command": "npx",
      "args": ["tsx", "mcp/ocs-server.ts"],
      "cwd": "/Users/jjackson/emdash-projects/worktrees/new-setup-82b"
    }
  }
}
```

(Preserve existing hooks in the file.)

- [ ] **Step 3: Commit**

```bash
git add mcp/ocs-server.ts .claude/settings.local.json
git commit -m "feat: add OCS MCP server scaffold with 5 tool stubs"
```

---

### Task 10: Starter Templates

**Files:**
- Create: `templates/idd-template.md`
- Create: `templates/onboarding-email-template.md`

- [ ] **Step 1: Write IDD template**

File: `templates/idd-template.md`

```markdown
# Intervention Design Document (IDD)

## Opportunity: [Name]
**Date:** [Date]
**Author:** [Name]

---

## Problem Statement
[What health/development problem does this intervention address?]

## Intervention Design
[How does the intervention work? What is the mechanism of change?]

## Learn App Specification
### Data Collection
- [What data do FLWs collect?]

### Visit Structure
- Visit frequency: [daily/weekly/monthly]
- Expected visits per FLW: [number]
- Duration per visit: [minutes]

### Forms
| Form Name | Purpose | Key Fields |
|-----------|---------|------------|
| | | |

## Deliver App Specification
### Services Delivered
- [What services do FLWs deliver?]

### Workflow
- [Step-by-step service delivery workflow]

### Case Management
- Case types: [list]
- Case lifecycle: [create → update → close criteria]

## Target Population
- Beneficiary criteria: [who]
- Geographic scope: [where]
- Expected reach: [number of beneficiaries]

## FLW Requirements
- Number of FLWs: [number]
- Skills/qualifications: [list]
- Geographic distribution: [description]

## LLO Preference
- Preferred LLOs: [names, if known]
- LLO criteria: [what capabilities are needed]

## Success Metrics
| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| | | |

## Timeline
- Start date: [date]
- End date: [date]
- Key milestones:
  - [Milestone 1]: [date]
  - [Milestone 2]: [date]

## Budget
- Estimated cost: [amount]
- Payment structure: [per visit / per delivery / fixed]
```

- [ ] **Step 2: Write onboarding email template**

File: `templates/onboarding-email-template.md`

```markdown
# Onboarding Email Template

**From:** Ace-AI@Dimagi.com
**CC:** CRISPR Admin Dimagi Google Group
**Subject:** [Opportunity Name] — Welcome and Next Steps

---

Dear [LLO Contact Name],

Welcome to [Opportunity Name]! We're excited to partner with [LLO Name] on this
initiative.

## Opportunity Overview
[Brief description of the intervention and what we're trying to achieve]

## Your Next Steps

1. **Review Training Materials**
   - LLO Manager Guide: [link]
   - FLW Training Guide: [link]
   - Quick Reference Card: [link]

2. **Onboard Your FLWs**
   - Number of FLWs needed: [number]
   - FLW requirements: [brief list]
   - Deadline for FLW onboarding: [date]

3. **Install the Apps**
   - Instructions for installing CommCare on FLW devices
   - App download link: [link]

## Timeline
- **[Date]:** FLW onboarding complete
- **[Date]:** Data collection begins
- **[Date]:** First progress check
- **[Date]:** Opportunity ends

## Getting Help
- **Email:** Ace-AI@Dimagi.com (AI-assisted, monitored by Dimagi team)
- **FAQ:** [link to FAQ document]
- **Escalation:** For urgent issues, contact [escalation contact]

We look forward to a successful partnership!

Best regards,
ACE (AI Connect Engine)
Dimagi
```

- [ ] **Step 3: Commit**

```bash
git add templates/
git commit -m "feat: add starter templates for IDD and onboarding email"
```

---

### Task 11: Generate Initial Playbook

Run the logic that the `/ace:docs` command describes to generate the first playbook.

**Files:**
- Create: `docs/generated/playbook.md`

- [ ] **Step 1: Generate the playbook**

Read all agent definitions, skill definitions, and integration specs. Stitch them together into the human-readable playbook at `docs/generated/playbook.md`.

The playbook should follow the structure defined in `commands/docs.md`:
- Overview (from ace-orchestrator)
- Process Flow (sequential step list)
- Phase sections with agent + skill summaries
- External Integrations summary
- Current Limitations (all workaround sections)
- Skill Reference table

- [ ] **Step 2: Commit**

```bash
git add docs/generated/playbook.md
git commit -m "feat: generate initial playbook from agent and skill definitions"
```

---

### Task 12: Final Verification and Cleanup

- [ ] **Step 1: Verify plugin structure**

Run this to verify all expected files exist:

```bash
echo "=== Plugin Metadata ==="
cat .claude-plugin/plugin.json | head -3

echo "=== Agents ==="
ls agents/

echo "=== Commands ==="
ls commands/

echo "=== Skills ==="
ls skills/*/SKILL.md

echo "=== Integration Specs ==="
ls playbook/integrations/

echo "=== MCP Servers ==="
ls mcp/

echo "=== Templates ==="
ls templates/

echo "=== Generated Docs ==="
ls docs/generated/
```

Expected output:
```
=== Plugin Metadata ===
{
  "name": "ace",
  "version": "0.1.0",
=== Agents ===
ace-orchestrator.md  app-builder.md  closeout.md  connect-setup.md  llo-manager.md
=== Commands ===
docs.md  run.md  status.md  step.md
=== Skills ===
skills/app-deploy/SKILL.md
skills/app-test/SKILL.md
skills/connect-opp-setup/SKILL.md
skills/connect-program-setup/SKILL.md
skills/cycle-grade/SKILL.md
skills/flw-data-review/SKILL.md
skills/idea-to-idd/SKILL.md
skills/idd-to-deliver-app/SKILL.md
skills/idd-to-learn-app/SKILL.md
skills/learnings-summary/SKILL.md
skills/llo-feedback/SKILL.md
skills/llo-invite/SKILL.md
skills/llo-onboarding/SKILL.md
skills/opp-closeout/SKILL.md
skills/ocs-agent-setup/SKILL.md
skills/timeline-monitor/SKILL.md
skills/training-materials/SKILL.md
=== Integration Specs ===
commcare-api.md  connect-api.md  nova-integration.md  ocs-integration.md
=== MCP Servers ===
google-drive-server.ts  ocs-server.ts
=== Templates ===
idd-template.md  onboarding-email-template.md
=== Generated Docs ===
playbook.md
```

- [ ] **Step 2: Update README**

Update `README.md` with a brief description pointing to the design spec and generated playbook.

- [ ] **Step 3: Final commit and push**

```bash
git add -A
git commit -m "feat: complete ACE plugin v0.1.0 — 5 agents, 17 skills, 4 commands, 2 MCP servers"
git push origin emdash/new-setup-82b
```
