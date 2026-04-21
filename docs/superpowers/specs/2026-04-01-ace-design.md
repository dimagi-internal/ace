# ACE (AI Connect Engine) — Design Spec

## Overview

ACE is a Claude Code plugin that orchestrates the CRISPR-Connect lifecycle — taking an idea through app building, Connect setup, LLO management, and closeout. It operates as an AI "mid-level operator" of a Connect opportunity, automating the 21-step process flow designed by Matt (Managing Director of Connect).

ACE follows the same architecture as the canopy plugin: agents orchestrate skills, skills are prompt-based capability definitions, and MCP servers provide programmatic access to external systems.

## Goals

1. **Living operational playbook** — ACE's plugin structure IS the plan. The agent definitions, skill files, and integration docs are both the system's instructions and the team's documentation.
2. **Two execution modes** — "auto" (runs through, emails admin group at checkpoints) and "review" (pauses at gates for human approval). Both modes execute the same steps.
3. **Self-improving** — skills improve by editing the SKILL.md and pushing to the plugin repo. Same pattern as canopy.
4. **Individually replaceable components** — each skill handles one step. Improving ACE means improving one skill at a time.
5. **Generated documentation** — `/ace:docs` generates a human-readable playbook from agent and skill definitions, always in sync with the actual system.

## Success Criteria

**Efficiency:**
- Time from Idea approval to LLO Proof of Concept Live within one week by the end of Q2 2026 with little to no Dimagi intervention required.

**Quality:**
- LLM-as-Judge pass rates at each gate ≥ 80% on first attempt (meaning ACE's drafts are good enough 4/5 times)
- Zero "bad sends" — no emails, app publishes, or invitations that had to be recalled due to ACE error

**Coverage:**
- All 19 steps executable by end of Q2 2026 without manual fallback before the end of Q2 2026

**Learning:**
- Each cycle produces concrete SKILL.md improvements pushed to the repo
- Learnings-summary skill produces actionable PDD seeds for next cycle

## Architecture

### Plugin Structure

```
ace/
├── .claude-plugin/
│   └── plugin.json
├── agents/
│   ├── ace-orchestrator.md          # Top-level: dispatches to phase agents
│   ├── app-builder.md               # PDD → Nova → test → deploy to CommCareHQ
│   ├── connect-setup.md             # Workspace → Program → Opportunity → config → invites
│   ├── llo-manager.md               # Onboarding → OCS → monitoring
│   └── closeout.md                  # Invoicing → feedback → learnings → grading
├── commands/
│   ├── run.md                       # /ace:run <opp-id> [--mode auto|review] [--dry-run]
│   ├── step.md                      # /ace:step <step-name> <opp-id>
│   ├── status.md                    # /ace:status [opp-id]
│   └── docs.md                      # /ace:docs — generate playbook from source
├── skills/
│   ├── idea-to-pdd/SKILL.md
│   ├── pdd-to-learn-app/SKILL.md
│   ├── pdd-to-deliver-app/SKILL.md
│   ├── app-test/SKILL.md
│   ├── app-deploy/SKILL.md
│   ├── training-materials/SKILL.md
│   ├── connect-program-setup/SKILL.md
│   ├── connect-opp-setup/SKILL.md
│   ├── llo-invite/SKILL.md
│   ├── llo-onboarding/SKILL.md
│   ├── llo-uat/SKILL.md
│   ├── llo-launch/SKILL.md
│   ├── ocs-agent-setup/SKILL.md
│   ├── timeline-monitor/SKILL.md
│   ├── flw-data-review/SKILL.md
│   ├── opp-closeout/SKILL.md
│   ├── llo-feedback/SKILL.md
│   ├── learnings-summary/SKILL.md
│   └── cycle-grade/SKILL.md
├── playbook/
│   └── integrations/
│       ├── connect-api.md           # Connect API requirements + gaps
│       ├── commcare-api.md          # CommCare API requirements + gaps
│       ├── ocs-integration.md       # OCS agent management + transcript access
│       └── nova-integration.md      # Nova fork/API requirements
├── mcp/
│   ├── google-drive-server.ts       # Google Drive + Sheets MCP (built)
│   └── ocs-server.ts                # OCS MCP (to build)
├── templates/                       # Email, PDD, training, collateral templates
├── scripts/                         # Utility scripts for skills
└── docs/
    └── generated/
        └── playbook.md              # Auto-generated from /ace:docs
```

### Agents

The top-level ace-orchestrator dispatches to 4 phase agents. Each phase agent knows its step ordering, dependencies, gate behavior, and mode logic (auto vs. review). Workflow logic lives in the agent definitions, not in a separate manifest.

| Agent | Skills it orchestrates | Primary owner |
|-------|----------------------|---------------|
| **ace-orchestrator** | Dispatches to phase agents, tracks overall opp state | Jon |
| **app-builder** | idea-to-pdd, pdd-to-learn-app, pdd-to-deliver-app, app-deploy, app-test, training-materials | Cal + Neal |
| **connect-setup** | connect-program-setup, connect-opp-setup, llo-invite | Cal |
| **llo-manager** | llo-onboarding, llo-uat, llo-launch, ocs-agent-setup, timeline-monitor, flw-data-review | Jon |
| **closeout** | opp-closeout, llo-feedback, learnings-summary, cycle-grade | Jon |

The agent/skill boundary is expected to evolve. We may collapse or split agents as we test. The current grouping reflects natural phases of the process.

### Skills (19)

Each skill is a SKILL.md file that handles one step of the CRISPR-Connect process. Skills are stateless prompt definitions that Claude executes. They read from and write to the opportunity's Google Drive folder and call MCP tools for external system access.

**Process flow with skill mapping:**

| # | Step | Skill | LLM Judge | Notes |
|---|------|-------|-----------|-------|
| 1 | Establish contracts with LLOs | (manual — Sarvesh) | | Not automated |
| 2 | Idea generated | (trigger) | | Neal generates initial ideas |
| 3 | AI-supported concept iteration → PDD | `idea-to-pdd` | Yes | Neal upskills Shakes for this |
| 4 | Pass PDD to Nova → Learn app | `pdd-to-learn-app` | Yes | Depends on Nova bot API |
| 5 | Pass PDD to Nova → Deliver app | `pdd-to-deliver-app` | Yes | Can run parallel with step 4 |
| 6 | Upload apps to CCHQ, build & publish | `app-deploy` | | Uses CommCare CLI/MCP |
| 7 | Automated test plan & execution | `app-test` | Yes | Explore GS team's work |
| 8 | Create training materials | `training-materials` | Yes | Can run parallel with step 7 |
| 9 | Create/configure Program in Connect | `connect-program-setup` | | Needs Program API (CCC-301) |
| 10 | Create/configure Opportunity | `connect-opp-setup` | | Needs Opportunity API (CCC-301) |
| 11 | Configure verification rules, units, payments | `connect-opp-setup` | | Folded into opp setup — may split into own skill if complex |
| 12 | Look up LLO contacts, send invites | `llo-invite` | | Needs Invite API + LLO Directory |
| 13 | Email LLOs with training + instructions | `llo-onboarding` | | Via Ace-AI@Dimagi.com |
| 14 | LLO User Acceptance Testing | `llo-uat` | | LLOs test apps before go-live |
| 15 | Opportunity Go-Live | `llo-launch` | | Activate opportunity, notify LLOs (gate step) |
| 16 | OCS answer bot for LLO questions | `ocs-agent-setup` | Yes | ACE configures OCS agent per opp |
| 17 | Monitor LLO timeline compliance | `timeline-monitor` | Yes | Recurring during active opp |
| 18 | Review FLW data, suggest improvements | `flw-data-review` | Yes | Recurring during active opp |
| 19 | Pull invoices, create Jira payment ticket | `opp-closeout` | | Triggered at opp end date |
| 20 | Prompt LLO for feedback | `llo-feedback` | | |
| 21 | Summarize learnings, create new PDD | `learnings-summary` | | Can trigger another cycle |
| 22 | Grade overall CRISPR-Connect cycle | `cycle-grade` | Yes | |

### MCP Servers

**In ACE repo:**
- **Google Drive MCP** (`mcp/google-drive-server.ts`) — Sheets + Drive tools. Already built. Service account: `ace-service-account@connect-labs.iam.gserviceaccount.com`. The SA key is resolved by the server itself from (1) `$GOOGLE_APPLICATION_CREDENTIALS` if set, else (2) `$CLAUDE_PLUGIN_DATA/gws-sa-key.json`, else (3) a legacy plugin-root path. `CLAUDE_PLUGIN_DATA` is passed through via the `mcpServers.ace-gdrive.env` block in `.claude-plugin/plugin.json` (inline rather than a plugin-root `.mcp.json` — see [anthropics/claude-code#9427](https://github.com/anthropics/claude-code/issues/9427) for why). Key persists across plugin updates and is shared across all worktrees/installs. This is the canonical Google Drive MCP, registered in canopy's registry for cross-project use.
- **OCS MCP** (`mcp/ocs-server.ts`) — To build. Agent management (create/configure agents per opportunity), transcript access (read LLO conversations for analysis), context injection.

**In connect-labs (external):**
- **commcare-hq MCP** — 26 tools. CommCare app structure, Connect solicitations/reviews/awards/funds, Google Sheets reading. Production-ready.
- Needs extension with: Program/Opportunity CRUD (CCC-301), invite API, verification rules, delivery units, payment config, invoice pull.

**Not yet determined:**
- **Nova** — May need a fork to enable bot-controlled app generation. Needs exploration with Braxton.

### Opportunity State (Google Drive)

Each opportunity ACE manages gets a folder in Google Drive:

```
ACE/
  <opp-name>/
    state.yaml              # Current step, mode, timestamps, gate approvals
    pdd.md                  # Program Design Doc
    app-summaries/
      learn-app-summary.md
      deliver-app-summary.md
    test-results/
    training-materials/
    comms-log/
    closeout/
```

The team can open any opportunity folder and see exactly where things stand. ACE reads/writes this programmatically via the Google Drive MCP.

### Execution Modes

**Auto mode:** ACE runs through all steps without pausing. Emails the CRISPR Admin Dimagi Google Group (Neal, Jon, Matt, Sarvesh, Cal) at each step completion and on failures. Gates are logged but not enforced.

**Review mode:** ACE pauses at gate steps and waits for human approval before proceeding. Gates are defined in each agent's logic. Key gates:
- PDD approval (before building apps)
- App deployment approval (before publishing to CCHQ)
- LLO invite approval (before sending invitations)

### LLM-as-Judge

10 of the 19 skills have LLM-as-Judge evaluation. This means ACE evaluates the quality of its own output at that step before proceeding. The criteria are defined within each skill's SKILL.md. Over time, these evaluations improve as skills are refined.

### OCS Integration

OCS is ACE's "mouth and ears" for LLO interaction. ACE manages OCS — it creates and configures an OCS agent per opportunity, injecting the PDD, training materials, and opportunity context. LLO questions come in via Ace-AI@Dimagi.com, are handled by OCS, and ACE monitors the transcripts via OCS APIs (already exist) to analyze sentiment, identify issues, and recommend next steps. All OCS responses are cc'd to the admin group for monitoring.

## Technical Enablement (Parallel Track)

These are the APIs and platform changes Cal's team needs to build. They unblock specific ACE skills.

| Priority | What | Where | Ticket | Blocks |
|----------|------|-------|--------|--------|
| 1 | REST API for Program + Opportunity creation | Connect backend + connect-labs MCP | CCC-301 | connect-program-setup, connect-opp-setup |
| 2 | New generic delivery type ("Experiment") | Connect backend | — | connect-opp-setup |
| 3 | LLO Directory in proper data model/DB | Connect backend | — | llo-invite |
| 4 | v2 LLO Entity implementation | Connect backend | CCC-300 | llo-invite, llo-onboarding |
| 5 | Invoice pull + Jira ticket creation | Connect backend | — | opp-closeout |
| — | Verification rules / delivery units / payment config API | Connect backend + connect-labs MCP | — | connect-opp-setup |
| — | Invite API | Connect backend + connect-labs MCP | — | llo-invite |
| — | Combine Learn + Deliver into single HQ app | CommCare | — | (nice to have) |
| — | connect-cli | — | — | (nice to have) |

Skills that depend on unbuilt APIs start as stubs with manual fallback instructions.

## Testing and Dry-Run Strategy

ACE has real-world side effects (emails, app publishes, Jira tickets, LLO invitations). We need a way to test without those side effects.

**Dry-run mode (`/ace:run <opp-id> --dry-run`):**
- All skills execute normally and produce outputs in the opp folder
- Effectful skills write their intended action to `comms-log/dry-run-<step>.md` instead of executing
  - e.g., llo-invite writes the email it *would* send, to whom, with what attachments
  - e.g., app-deploy writes the API call it *would* make and the app JSON
- LLM-as-Judge still runs and gates still apply
- State.yaml tracks steps as `dry-run-success` or `dry-run-blocked`

**Test fixtures:**
- A synthetic opportunity ("CRISPR-Test-001") lives permanently in the ACE Google Drive folder
- It has a fake PDD, fake LLO contacts (team members), and fake app summaries
- New skills can be tested against this fixture before being run on real opportunities

**Sandbox environment:**
- For steps that hit Connect APIs or CommCareHQ: Cal maintains a staging instance
- Skills that call external APIs should accept a `--sandbox` flag that routes to staging endpoints
- MCP server configs include staging URLs alongside production

## Improvement Model

Same as canopy. Skills improve by editing the SKILL.md and pushing to the plugin repo. The goal is continuous self-improvement:

1. Run a skill on a real opportunity
2. Evaluate the output (LLM-as-Judge + human review)
3. Identify what went wrong or could be better
4. Edit the SKILL.md with better instructions, examples, or tool usage
5. Push to the ACE plugin repo
6. Next run uses the improved skill

No formal interface contracts or versioning beyond what git provides. The agent definitions and skill files are the source of truth.

**How ACE skill improvement differs from canopy:** Canopy skills mostly produce documents and analysis — a bad output wastes time but doesn't create external damage. ACE skills can send emails, publish apps, and create financial tickets. This means:

- **Regression testing.** After editing a SKILL.md, re-run it against the test fixture (CRISPR-Test-001) before running on real opportunities.
- **Changelog in SKILL.md.** Each skill maintains a `## Change Log` section at the bottom with date, change description, and who made it. Git provides this too, but an in-file log makes it visible to Claude when executing the skill.

## Generated Documentation

`/ace:docs` reads all agent definitions and skill files and generates a single human-readable playbook at `docs/generated/playbook.md`. This document:
- Explains the full CRISPR-Connect process flow
- Documents what each agent and skill does
- Shows the dependency graph between steps
- Lists gate points and mode behavior
- Describes MCP integrations and what APIs are needed
- Is always in sync with the actual system because it's generated from the source

## Key Stakeholders

| Person | Role | Owns |
|--------|------|------|
| Matt | Managing Director of Connect, initiative owner | Process flow, business requirements |
| Neal | Idea generation, PDD creation | idea-to-pdd skill, initial ideas |
| Cal | CommCare/Connect tech lead | app-builder agent, connect-setup agent, Connect APIs |
| Sarvesh | LLO contracts, Auto-Connect | LLO relationships, testing |
| Jon | ACE agent development | llo-manager agent, closeout agent, MCP servers, overall architecture |

## Source Reference

Planning spreadsheet: https://docs.google.com/spreadsheets/d/1XxcPxK1oYtDxcfmElBb73U2UtLYEodiaMUazjmEVAWE/edit
- Tab "Process Flow" — 21-step process with owners, skills, and next steps
- Tab "Connect Tech Work" — Prioritized API/platform work for Cal's team
