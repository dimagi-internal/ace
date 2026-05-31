# ACE — AI Connect Engine

Orchestrates the ACE lifecycle for Connect opportunities, from idea through app building, deployment, LLO management, and closeout.

ACE is a Claude Code plugin with the same architecture as canopy: agents orchestrate skills, skills are prompt-based capability definitions, and MCP servers provide programmatic access to external systems.

## Prerequisites

Before `/ace:setup` will succeed, you need:

- **Node.js v18+** with `npm` (https://nodejs.org). Apple Silicon: `brew install node`.
- **1Password CLI** (`op`). Mac: `brew install 1password-cli`. Other platforms: https://developer.1password.com/docs/cli/get-started/.
  - On Mac, also enable 1Password.app → Settings → Developer → "Connect with 1Password CLI" for biometric unlock — that's the smoothest auth path. Alternative: `op signin --account dimagi.1password.com` interactively when `/ace:setup` prompts.
- **1Password account** at `dimagi.1password.com`, with **read access to the `AI-Agents` vault**. Ask Jon (or whoever owns the vault) to grant access — without it, `op inject` will fail with cryptic permission errors. The full set of items ACE reads from `AI-Agents`: `ACE - Google Service Account` (Document), `ACE - Open Chat Studio`, `ACE - CommCareHQ`, `ACE - Connect Labs`, `Content Generator API`, `connect-test-user`, plus two UUID-referenced API-key items (linked from `.env.tpl`).
- **GitHub access to `jjackson/ace`** (currently public; no extra step needed). `gh auth login` is not required unless you plan to push.
- **Network reachability** to `openchatstudio.com`, `connect.dimagi.com`, `commcarehq.org`, `labs.connect.dimagi.com`, `googleapis.com`. Corp VPNs and proxies sometimes block these — `/ace:doctor` reports an explicit status per host.
- **Playwright Chromium** browser binary. Auto-installed on first use; if you hit "browser doesn't open" errors, run `npx playwright install chromium`.

**Mobile (Phase 6 only) is currently Mac-only.** Phases 1–4 and 6–9 work on Mac, Linux, and Windows. Phase 6 (mobile screenshot capture against an Android emulator) has only been live-validated on macOS Apple Silicon — the Linux/Windows installer commands in `commands/mobile-bootstrap.md` exist but haven't been tested end-to-end. If you're on Windows, you can run everything except Phase 6; ask Jon for the workaround.

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

2. **Run `/ace:setup`** — does almost everything for you in one shot:
   verifies Node + `op` + 1Password signin, fetches the GWS service-account
   key from the `AI-Agents` vault into `${CLAUDE_PLUGIN_DATA}/gws-sa-key.json`,
   runs `npm install`, injects `.env` from `1Password`, and finishes by
   running `/ace:doctor`.
   - If `op` isn't signed in, the script prints the exact
     `! op signin --account dimagi.1password.com` line — type it in the
     chat (the `!` prefix runs the command in this session), then re-run
     `/ace:setup`.
   - If 1Password can't find the SA-key Document, the script lists
     candidate items in `AI-Agents` so you can pick the right one with
     `ACE_GWS_KEY_OP_DOC=...`. Worst case, ask Jon for the JSON and drop
     it manually at the path the script printed.

3. **Authenticate to OCS** — `/ace:ocs-login` opens a headed browser so you
   can sign in (SSO/MFA included). Session state is saved to
   `~/.ace/ocs-session-<team>.json` for headless reuse.
   - Most colleagues won't need this step: if `OCS_USERNAME` /
     `OCS_PASSWORD` resolved into `.env` (they do by default for
     `ace@dimagi-ai.com`), the MCP backend auto-logs-in on first call.
     `/ace:ocs-login` is the manual fallback for SSO/MFA edge cases.

4. **Verify with `/ace:doctor`** — all checks should be PASS or WARN. Any
   FAIL line is a hard blocker; any WARN tells you what's missing for a
   particular phase (e.g., mobile bootstrap, training-deck template).

5. **Try a dry run** — `/ace:run --dry-run` (zero-arg smart defaults), or
   `/ace:run <opp-name> --dry-run` if you want a specific slug. With no
   arguments, ACE auto-generates `smoke-<timestamp>` and walks you through
   a Drive-based PDD picker. All effectful actions (emails, publishes,
   tickets) are logged to `comms-log/dry-run-<step>.md` instead of
   executing.

After step 5 passes, you're ready to run a real opportunity with
`/ace:run --mode review` (or `/ace:run <opp-name> --mode review` for a
named slug).

> **Note for new colleagues:** `/ace:ocs-bootstrap-template` is a *one-time
> per ACE environment* setup, not a per-colleague step. The shared OCS
> golden template ID lives in 1Password (`OCS_GOLDEN_TEMPLATE_ID`) and
> resolves into your `.env` automatically. You only run it if you're
> standing up ACE against a new OCS team or refreshing the template's
> system prompt. If `/ace:doctor` says
> `ocs_env: ... OCS_GOLDEN_TEMPLATE_ID ... missing`, fix the 1Password
> reference first — don't run the bootstrap.

## Setup

ACE is a Claude Code plugin that bundles a Google Drive MCP server
(`mcp/google-drive-server.ts`) plus an OCS MCP server (`mcp/ocs-server.ts`).
They are declared inline in `.claude-plugin/plugin.json` under `mcpServers`
and auto-register when the plugin is installed. (They used to live in a
separate `.mcp.json` at the plugin root; see 0.5.16 for the move and the
[upstream Claude Code bug](https://github.com/anthropics/claude-code/issues/9427)
that forced it.)

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

The `plugin.json` `mcpServers.ace-gdrive.env` block passes
`CLAUDE_PLUGIN_DATA` through; the server composes the key path in Node as
`$CLAUDE_PLUGIN_DATA/gws-sa-key.json`. Operators can still set
`GOOGLE_APPLICATION_CREDENTIALS` explicitly if they want to override.

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

All five MCP servers are wired inline in `.claude-plugin/plugin.json`
under `mcpServers` and auto-register on plugin install:

- **`ace-gdrive`** — Google Drive + Docs + Slides + Sheets. Authenticated
  via the service-account key dropped by `/ace:setup`.
- **`ace-ocs`** — Open Chat Studio (composite REST + Playwright backend).
  Authenticate with `/ace:ocs-login` for SSO/MFA edge cases; otherwise
  the MCP auto-logs-in from `OCS_USERNAME` / `OCS_PASSWORD` in `.env`.
- **`ace-connect`** — `connect.dimagi.com` (composite REST + Playwright).
  Includes 5 `commcare_*` atoms for app release / multimedia. Authenticate
  with `/ace:connect-login` for MFA; otherwise auto-logs-in from
  `ACE_HQ_USERNAME` / `ACE_HQ_PASSWORD` via OAuth-with-CommCareHQ.
- **`ace-mobile`** — local Maestro + AVD for Phase 6 (Mac-only today).
  Bootstrap with `/ace:mobile-bootstrap`.
- **`connect-labs`** — stdio proxy forwarding JSON-RPC to
  `https://labs.connect.dimagi.com/mcp/`. Used by Phase 8 (solicitations).
  Mint a PAT with `/ace:labs-token-mint` if `/ace:doctor` flags
  `LABS_MCP_TOKEN` as missing.

Nova ships as a sibling Claude Code plugin (not part of ACE). Install
once with `/plugin install nova@nova-marketplace`; ACE's Phase 3
delegates app-build to `/nova:autobuild`. See
`playbook/integrations/nova-integration.md` for the integration contract.

## Architecture

- **12 agents** — `ace-orchestrator` + 10 phase agents (`idea-to-design`, `scenarios-and-acceptance`, `commcare-setup`, `connect-setup`, `ocs-setup`, `qa-and-training`, `synthetic-data-and-workflows`, `solicitation-management`, `execution-manager`, `closeout`) + `ocs-tester` (ad-hoc QA+Eval)
- **~65 skills** — one per process step, each a SKILL.md that Claude executes. Evaluation is a two-phase `-qa` / `-eval` pattern (see `skills/README.md § QA vs Eval`), with the `opp-eval` umbrella aggregator rolling per-skill verdicts into a run-level scorecard
- **15 commands** — `run`, `step`, `status`, `eval`, `qa-deep`, `docs`, `setup`, `update`, `doctor`, `ocs-login`, `connect-login`, `labs-login`, `labs-token-mint`, `mobile-bootstrap`, `ocs-bootstrap-template`
- **5 MCP servers** — Google Drive (`ace-gdrive`), OCS (`ace-ocs`), Connect (`ace-connect`), Mobile (`ace-mobile`), Connect Labs (`connect-labs`, stdio proxy to `labs.connect.dimagi.com/mcp/`)
- **10 phases** — idea-to-design → scenarios-and-acceptance → commcare-setup → connect-setup → ocs-setup → qa-and-training → synthetic-data-and-workflows → solicitation-management → execution-manager → closeout (Phases 1–7 run end-to-end with zero LLO involvement; Phase 8 publishes a public solicitation; Phase 9 is the first 1-1 contact with the awarded LLO)
- **2 execution modes** — auto (hands-off) and review (pauses at gates)

## Documentation

- [CLAUDE.md](CLAUDE.md) — agent guide, phase pipeline, conventions, gotchas
- [agents/orchestrator-reference.md](agents/orchestrator-reference.md) — state schemas, phase write-back contract, pause points, fork points
- [Integration Specs](playbook/integrations/) — per-MCP integration reference and durable gotcha records (OCS, Nova, Connect, CommCare, labs, mobile, slides)
- [Generated Playbook](docs/generated/playbook.md) — derived process flow regenerated by `/ace:docs` (run the command to (re)create it)
- [Design Specs](docs/superpowers/specs/) — date-stamped design docs for in-flight or recently-shipped work
- [Durable Learnings](docs/learnings/) — cross-session lessons (Nova bugs, demo-user mechanics, Phase 6 validation arc, etc.)
- [PDD Stress-Test Observations](docs/examples/pdd-stress-test-observations.md) — how to validate a PDD and verify LLO execution, with two sample PDDs worked through end-to-end
- **`ace-web`** sibling repo — design spec for the browser-based ACE frontend lives in that repo, not here

## Related projects

- **[ace-web](https://github.com/jjackson/ace-web)** — the browser-based chat + transcript harness for ACE. Django + Channels + React on GCP Cloud Run, built against the design spec above. Implementation plans (1A, 1B, 1C, 1D) live inside that repo at `docs/plans/`. Work on ace-web implementation happens directly in the ace-web checkout, not from this repo.

## Planning Spreadsheet

https://docs.google.com/spreadsheets/d/1XxcPxK1oYtDxcfmElBb73U2UtLYEodiaMUazjmEVAWE/edit
