# ACE — AI Connect Engine

Orchestrates the CRISPR-Connect lifecycle for Connect opportunities, from idea through app building, deployment, LLO management, and closeout.

ACE is a Claude Code plugin with the same architecture as canopy: agents orchestrate skills, skills are prompt-based capability definitions, and MCP servers provide programmatic access to external systems.

## Quick Start

```
/plugin marketplace add jjackson/ace     # Add the ACE marketplace
/plugin install ace@ace                  # Install the plugin
/ace:setup                               # Install deps + verify the service-account key
/ace:doctor                              # Sanity-check everything

/ace:run <opp-name> --mode review        # Run full lifecycle
/ace:run <opp-name> --dry-run            # Test without side effects
/ace:run <opp-name> --sandbox            # Route to staging endpoints
/ace:step <skill-name> <opp-name>        # Run a single step
/ace:status                              # Show all opportunities
/ace:docs                                # Generate playbook
/ace:update                              # Pull the latest release from GitHub
```

## Setup

ACE is a Claude Code plugin that bundles a Google Drive MCP server
(`mcp/google-drive-server.ts`) plus an OCS MCP server (`mcp/ocs-server.ts`).
The `.mcp.json` manifest auto-registers them when the plugin is installed.

**One command sets everything up:**

```
/ace:setup
```

This detects the plugin root (whether you're in a marketplace install or a
local dev checkout), runs `npm install` so `tsx` and the Google API client are
available, verifies the service-account key is present, cross-checks the MCP
manifest, and (optionally with `--auto-update`) registers a `SessionStart` hook
that runs background update checks.

The one thing `/ace:setup` can't do for you is drop in the service-account
key — it's a secret you have to supply. When the setup script reports
`GWS_KEY: MISSING`, it prints the canonical path (under `$CLAUDE_PLUGIN_DATA`)
and the exact `mkdir -p … && mv … && chmod 600 …` command to run. That
location is persistent across plugin updates and shared by every worktree and
install, so you only drop the key once per machine.

The `.mcp.json` passes the path to the MCP server via the standard
`GOOGLE_APPLICATION_CREDENTIALS` env var, expanded from
`${CLAUDE_PLUGIN_DATA}/gws-sa-key.json` at server launch.

The service account needs `https://www.googleapis.com/auth/spreadsheets`,
`https://www.googleapis.com/auth/drive`, and
`https://www.googleapis.com/auth/documents` scopes. The ACE service account is
`ace-service-account@connect-labs.iam.gserviceaccount.com` — ask Jon for the
key. It must be added as Editor on the ACE folder inside the Shared Drive for
artifact creation to work; see the "Shared Drive" note below.

After dropping the key, re-run `/ace:setup` and then `/reload-plugins`. The
`ace-gdrive` MCP server should appear in `/mcp`.

#### Shared Drive requirement

ACE skills create Google Docs inside an ACE folder that **must live in a
Google Shared Drive**, not in anyone's "My Drive". Service accounts have zero
personal Drive storage quota, so creating files under a My Drive folder fails
with `Service Accounts do not have storage quota`. Inside a Shared Drive the
Drive itself owns the files, and the SA only needs Editor permission on the
target folder.

### Verify

```
/ace:doctor
```

Cross-checks version consistency, dependencies, the service-account key, the
MCP manifest, and related repos (`ace-web`, `connect-labs`). Prints PASS / WARN
/ FAIL for each check with a fix hint. Run this any time something feels off.

### Updating

```
/ace:update
```

Pulls the latest release from `~/.claude/plugins/marketplaces/ace`, copies it
into a new versioned cache dir, reinstalls deps, updates
`installed_plugins.json`, and tells you to `/reload-plugins`. Your
service-account key lives in `$CLAUDE_PLUGIN_DATA`, which is outside the
versioned cache dir, so it automatically carries forward without any special
handling. See [CHANGELOG.md](CHANGELOG.md) for release notes.

If you'd rather not run this by hand, `/ace:setup --auto-update` registers a
`SessionStart` hook that checks for new versions in the background every
session (cached 60 min when up-to-date, 720 min when there's an upgrade
available, with a snoozeable 24h/48h/7d backoff borrowed from gstack).

### Manual install (dev checkouts)

If you're hacking on the plugin locally rather than via the marketplace, clone
the repo and run `npm install` yourself. `/ace:setup` and `/ace:doctor` still
work — they detect the repo by walking up from `$PWD` looking for
`.claude-plugin/plugin.json`.

### Other MCP servers

The OCS MCP (`mcp/ocs-server.ts`) is wired into `.mcp.json` as `ace-ocs`. It is
partially implemented — see `playbook/integrations/ocs-integration.md` and the
`mcp/ocs/` backends. Authenticate with `/ace:ocs-login` before calling any tool
that hits the live service.

The CommCare and Connect MCPs live in the `connect-labs` repo, not in this plugin. To use them in a Claude Code session today, install the connect-labs MCP separately. ACE skills that depend on them have `## Current Workaround` sections that degrade to human-in-the-loop until those servers are also wired into a Claude Code plugin manifest.

The Nova MCP does not exist yet — see `playbook/integrations/nova-integration.md`.

## Architecture

- **6 agents** — ace-orchestrator + 4 phase agents (app-builder, connect-setup, llo-manager, closeout) + ocs-tester
- **21 skills** — one per process step, each a SKILL.md that Claude executes
- **9 commands** — `run`, `step`, `status`, `docs`, `ocs-login`, `ocs-bootstrap-template`, `setup`, `update`, `doctor`
- **2 MCP servers** — Google Drive (`ace-gdrive`), OCS (`ace-ocs`)
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
