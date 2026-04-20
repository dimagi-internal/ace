# ACE — AI Connect Engine

Orchestrates the CRISPR-Connect lifecycle for Connect opportunities, from idea through app building, deployment, LLO management, and closeout.

ACE is a Claude Code plugin with the same architecture as canopy: agents orchestrate skills, skills are prompt-based capability definitions, and MCP servers provide programmatic access to external systems.

## Quick Start

```
/plugin marketplace add jjackson/ace     # Add the ACE marketplace
/plugin install ace@ace                  # Install the plugin
/ace:setup                               # Install deps + verify the service-account key
/ace:doctor                              # Sanity-check everything

/ace:run                                 # Run full lifecycle (smart defaults)
/ace:run <opp-name> --mode review        # Run full lifecycle for a named slug
/ace:run --dry-run                       # Test without side effects
/ace:run --sandbox                       # Route to staging endpoints
/ace:step <skill-name> <opp-name>        # Run a single step
/ace:status                              # Show all opportunities
/ace:eval <opp-name> --mode deep         # Umbrella eval (aggregates verdicts/*)
/ace:docs                                # Generate playbook
/ace:update                              # Pull the latest release from GitHub
```

## First-Run Walkthrough

The commands above are only the happy path once everything is configured. For a
fresh install (or a new machine), run through this checklist top-to-bottom.
Stop at any step that fails — the next step won't work.

1. **Install the plugin** — `/plugin marketplace add jjackson/ace` then
   `/plugin install ace@ace`.

2. **Run `/ace:setup`** — installs npm deps, verifies tsx and the MCP
   manifest. It will tell you where to drop the Google service-account key
   if it's missing.

3. **Drop the GWS service-account key** — `/ace:setup` prints the exact
   `mkdir -p … && mv … && chmod 600 …` line when `GWS_KEY: MISSING`. Ask Jon
   for the key (service account:
   `ace-service-account@connect-labs.iam.gserviceaccount.com`). Re-run
   `/ace:setup` to confirm `GWS_KEY: ok`.

4. **Generate `.env`** from the 1Password-backed template:
   ```
   op inject -i .env.tpl -o ~/.claude/plugins/data/ace-ace/.env --account dimagi.1password.com
   ```
   This populates OCS credentials, the Gmail account, and the shared
   collection IDs. For a local dev checkout, write to `./.env` instead.

5. **Authenticate to OCS** — `/ace:ocs-login` opens a headed browser so you
   can sign in (SSO/MFA included). Session state is saved to
   `~/.ace/ocs-session-<team>.json` for headless reuse.

6. **Bootstrap the OCS golden template** (one time per ACE environment) —
   `/ace:ocs-bootstrap-template`. This creates the chatbot that
   `ocs-agent-setup` clones from for every new opportunity. Paste the
   printed `OCS_GOLDEN_TEMPLATE_ID`, `OCS_GOLDEN_TEMPLATE_PUBLIC_ID`, and
   `OCS_GOLDEN_TEMPLATE_EMBED_KEY` into your `.env`.

7. **Verify with `/ace:doctor`** — all checks should be PASS. Any WARN line
   tells you what's still missing (e.g., `.env` not found, OCS session
   expired, golden template not configured).

8. **Try a dry run** — `/ace:run --dry-run` (zero-arg smart defaults), or
   `/ace:run <opp-name> --dry-run` if you want a specific slug. With no
   arguments, ACE auto-generates `smoke-<timestamp>` and walks you through
   a Drive-based PDD picker. All effectful actions (emails, publishes,
   tickets) are logged to `comms-log/dry-run-<step>.md` instead of
   executing.

After step 8 passes, you're ready to run a real opportunity with
`/ace:run --mode review` (or `/ace:run <opp-name> --mode review` for a
named slug).

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

- **8 agents** — `ace-orchestrator` + 6 phase agents (`design-review`, `commcare-setup`, `connect-setup`, `ocs-setup`, `llo-manager`, `closeout`) + `ocs-tester` (ad-hoc QA+Eval)
- **24 skills** — one per process step, each a SKILL.md that Claude executes. Evaluation is a two-phase `-qa` / `-eval` pattern (see `skills/README.md § QA vs Eval`), with the `opp-eval` umbrella aggregator rolling per-skill verdicts into a run-level scorecard
- **10 commands** — `run`, `step`, `status`, `eval`, `docs`, `ocs-login`, `ocs-bootstrap-template`, `setup`, `update`, `doctor`
- **2 MCP servers** — Google Drive (`ace-gdrive`), OCS (`ace-ocs`)
- **6 phases** — design-review → commcare-setup → connect-setup → ocs-setup → llo-manager → closeout (Phases 1–4 run end-to-end before any LLO contact)
- **2 execution modes** — auto (hands-off) and review (pauses at gates)

## Documentation

- [Design Spec](docs/superpowers/specs/2026-04-01-ace-design.md) — full architecture and rationale
- [Generated Playbook](docs/generated/playbook.md) — human-readable process flow (generated from agent/skill definitions)
- [Integration Specs](playbook/integrations/) — what APIs exist vs. need to be built
- [ACE Web Harness Design](docs/superpowers/specs/2026-04-07-ace-web-harness-design.md) — cross-cutting architecture spec for the browser-based ACE frontend
- [PDD Stress-Test Observations](docs/examples/pdd-stress-test-observations.md) — how to validate an PDD and verify LLO execution, with two sample PDDs worked through end-to-end

## Related projects

- **[ace-web](https://github.com/jjackson/ace-web)** — the browser-based chat + transcript harness for ACE. Django + Channels + React on GCP Cloud Run, built against the design spec above. Implementation plans (1A, 1B, 1C, 1D) live inside that repo at `docs/plans/`. Work on ace-web implementation happens directly in the ace-web checkout, not from this repo.

## Planning Spreadsheet

https://docs.google.com/spreadsheets/d/1XxcPxK1oYtDxcfmElBb73U2UtLYEodiaMUazjmEVAWE/edit
