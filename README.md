# ACE — AI Connect Engine

Orchestrates the CRISPR-Connect lifecycle for Connect opportunities, from idea through app building, deployment, LLO management, and closeout.

ACE is a Claude Code plugin with the same architecture as canopy: agents orchestrate skills, skills are prompt-based capability definitions, and MCP servers provide programmatic access to external systems.

## Quick Start

Install as a Claude Code plugin, then complete the [Setup](#setup) below, then:

```
/ace:run <opp-name> --mode review    # Run full lifecycle
/ace:run <opp-name> --dry-run        # Test without side effects
/ace:run <opp-name> --sandbox        # Route to staging endpoints
/ace:step <skill-name> <opp-name>    # Run a single step
/ace:status                          # Show all opportunities
/ace:docs                            # Generate playbook
```

## Setup

ACE bundles a Google Drive MCP server (`mcp/google-drive-server.ts`) that the skills use to read/write opportunity state in Drive. It auto-registers via `.mcp.json` when the plugin is installed in Claude Code, but two one-time setup steps are required on each machine:

### 1. Install plugin dependencies

The MCP server is invoked as `npx tsx mcp/google-drive-server.ts`. `tsx` and the other Node dependencies (Google API client, MCP SDK) need to be installed in the plugin directory:

```bash
cd "$(find ~/.claude/plugins/cache/ace -maxdepth 2 -name package.json -exec dirname {} \; | head -1)"
npm install
```

If you're developing the plugin locally (not via Claude Code install), just `cd` into your checkout and `npm install` there.

### 2. Drop in the Google service-account key

The MCP server reads `.gws-sa-key.json` from the plugin root. This file is gitignored — you have to add it manually:

```bash
# Path depends on whether you're using the marketplace install or a local dev checkout.
# For marketplace install:
cp /path/to/your/sa-key.json ~/.claude/plugins/cache/ace/<version>/.gws-sa-key.json

# For local dev checkout:
cp /path/to/your/sa-key.json /path/to/your/ace/checkout/.gws-sa-key.json
```

The service account needs `https://www.googleapis.com/auth/spreadsheets` and `https://www.googleapis.com/auth/drive` scopes. The Dimagi service account currently used is `gws-local-dev@dimagi-chrome-extension.iam.gserviceaccount.com` — ask Jon for the key.

### 3. Verify

After install + key drop, restart your Claude Code session. The `ace-gdrive` MCP server should appear in `/mcp` and expose tools like `sheets_read`, `drive_read_file`, `drive_create_file`, etc. If it doesn't, check that `.gws-sa-key.json` exists at the plugin root and that `npm install` completed without errors.

### Other MCP servers

The OCS MCP (`mcp/ocs-server.ts`) is a scaffold — every tool currently returns `{status: 'not_implemented'}`. It is **not** wired into `.mcp.json` because exposing it would only add stub tools to the session. It will be added to `.mcp.json` once the underlying OCS endpoints are connected. Track this in `playbook/integrations/ocs-integration.md`.

The CommCare and Connect MCPs live in the `connect-labs` repo, not in this plugin. To use them in a Claude Code session today, install the connect-labs MCP separately. ACE skills that depend on them have `## Current Workaround` sections that degrade to human-in-the-loop until those servers are also wired into a Claude Code plugin manifest.

The Nova MCP does not exist yet — see `playbook/integrations/nova-integration.md`.

## Architecture

- **5 agents** — ace-orchestrator + 4 phase agents (app-builder, connect-setup, llo-manager, closeout)
- **19 skills** — one per process step, each a SKILL.md that Claude executes
- **4 commands** — run, step, status, docs
- **2 MCP servers** — Google Drive (built), OCS (scaffold)
- **2 execution modes** — auto (hands-off) and review (pauses at gates)

## Documentation

- [Design Spec](docs/superpowers/specs/2026-04-01-ace-design.md) — full architecture and rationale
- [Generated Playbook](docs/generated/playbook.md) — human-readable process flow (generated from agent/skill definitions)
- [Integration Specs](playbook/integrations/) — what APIs exist vs. need to be built
- [ACE Web Harness Design](docs/superpowers/specs/2026-04-07-ace-web-harness-design.md) — cross-cutting architecture spec for the browser-based ACE frontend
- [IDD Stress-Test Observations](docs/examples/idd-stress-test-observations.md) — how to validate an IDD and verify LLO execution, with two sample IDDs worked through end-to-end

## Related projects

- **[ace-web](https://github.com/jjackson/ace-web)** — the browser-based chat + transcript harness for ACE. Django + Channels + React on GCP Cloud Run, built against the design spec above. Implementation plans (1A, 1B, 1C, 1D) live inside that repo at `docs/plans/`. Work on ace-web implementation happens directly in the ace-web checkout, not from this repo.

## Planning Spreadsheet

https://docs.google.com/spreadsheets/d/1XxcPxK1oYtDxcfmElBb73U2UtLYEodiaMUazjmEVAWE/edit
